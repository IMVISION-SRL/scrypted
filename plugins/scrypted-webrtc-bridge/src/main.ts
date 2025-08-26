import sdk, { HttpRequest, HttpRequestHandler, HttpResponse, Program, ScryptedDeviceBase, ScryptedInterface, Setting, Settings, SettingValue, RTCSignalingOptions, RTCSignalingSession, RTCAVSignalingSetup, RTCSignalingSendIceCandidate } from '@scrypted/sdk';
import { Deferred } from '@scrypted/common/src/deferred';

const { systemManager, endpointManager } = sdk;

class ViewerSession implements RTCSignalingSession {
    __proxy_props: { options: RTCSignalingOptions };
    options: RTCSignalingOptions;
    deferred = new Deferred<RTCSessionDescriptionInit>();

    constructor(public offer: RTCSessionDescriptionInit, public configuration?: RTCConfiguration) {
        this.options = { requiresOffer: true, disableTrickle: true };
        this.__proxy_props = { options: this.options };
    }

    async createLocalDescription(type: 'offer' | 'answer', setup: RTCAVSignalingSetup, sendIceCandidate: RTCSignalingSendIceCandidate) {
        if (type !== 'offer')
            throw new Error('viewer session only supports offers');
        if (this.configuration)
            setup.configuration = this.configuration;
        return this.offer;
    }

    async setRemoteDescription(description: RTCSessionDescriptionInit, setup: RTCAVSignalingSetup) {
        this.deferred.resolve(description);
    }

    async addIceCandidate(candidate: RTCIceCandidateInit) {
        // no trickle
    }

    async getOptions(): Promise<RTCSignalingOptions> {
        return this.options;
    }

    getAnswer() {
        return this.deferred.promise;
    }
}

export class WebRTCBridge extends ScryptedDeviceBase implements HttpRequestHandler, Settings, Program {
    constructor(nativeId?: string) {
        super(nativeId);

        endpointManager.getLocalEndpoint(this.nativeId, { public: true, insecure: true }).then(url => {
            this.console.log('WHEP base endpoint:', url);
        }).catch(err => this.console.error('endpoint error', err));
    }

    async run() {
        // no-op
    }

    private getAllowedIds(): string[] | undefined {
        const allowed = this.storage.getItem('allowedCameras');
        if (!allowed)
            return undefined;
        try {
            return JSON.parse(allowed);
        }
        catch (e) {
            this.console.warn('failed to parse allowed camera list', e);
        }
    }

    async getSettings(): Promise<Setting[]> {
        return [
            {
                key: 'iceServers',
                title: 'ICE Servers',
                description: 'JSON array of RTCIceServer objects passed to RTCPeerConnection.',
                type: 'textarea',
                value: this.storage.getItem('iceServers') || '',
            },
            {
                key: 'allowedCameras',
                title: 'Allowed Cameras',
                description: 'Select cameras permitted for WHEP access. Leave empty to allow all.',
                type: 'device',
                multiple: true,
                deviceFilter: `interfaces.includes('${ScryptedInterface.RTCSignalingChannel}')`,
                value: this.getAllowedIds(),
            }
        ];
    }

    async putSetting(key: string, value: SettingValue) {
        if (key === 'allowedCameras')
            this.storage.setItem(key, JSON.stringify(value));
        else if (typeof value === 'string')
            this.storage.setItem(key, value);
    }

    private addCors(headers?: { [key: string]: string }) {
        return Object.assign({
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type',
        }, headers);
    }

    async onRequest(request: HttpRequest, response: HttpResponse) {
        if (request.method === 'OPTIONS') {
            response.send('', { headers: this.addCors() });
            return;
        }

        const url = new URL(request.url, 'http://localhost');
        const path = url.pathname.substring(request.rootPath.length);

        try {
            if (path === 'health') {
                response.send(JSON.stringify({ ok: true }), { headers: this.addCors({ 'Content-Type': 'application/json' }) });
                return;
            }

            if (path === 'cameras') {
                const allowed = this.getAllowedIds();
                const cameras = systemManager.getDeviceIds().map(id => systemManager.getDeviceById(id))
                    .filter(d => d?.interfaces?.includes(ScryptedInterface.RTCSignalingChannel))
                    .filter(d => !allowed || allowed.includes(d.id))
                    .map(d => ({ id: d.id, name: d.name }));
                response.send(JSON.stringify(cameras), { headers: this.addCors({ 'Content-Type': 'application/json' }) });
                return;
            }

            if (path === 'whep') {
                if (request.headers['content-type'] !== 'application/sdp') {
                    response.send('Unsupported Media Type', { code: 415, headers: this.addCors() });
                    return;
                }

                const deviceId = url.searchParams.get('deviceId');
                const name = url.searchParams.get('name');
                let device: any;
                if (deviceId)
                    device = systemManager.getDeviceById(deviceId);
                else if (name) {
                    for (const id of systemManager.getDeviceIds()) {
                        const d = systemManager.getDeviceById(id);
                        if (d?.name === name) {
                            device = d;
                            break;
                        }
                    }
                }
                if (!device || !device.interfaces?.includes(ScryptedInterface.RTCSignalingChannel)) {
                    response.send('Camera Not Found', { code: 404, headers: this.addCors() });
                    return;
                }

                const allowed = this.getAllowedIds();
                if (allowed && !allowed.includes(device.id)) {
                    response.send('Forbidden', { code: 403, headers: this.addCors() });
                    return;
                }

                const offerSdp = request.body?.toString();
                if (!offerSdp) {
                    response.send('Bad Request', { code: 400, headers: this.addCors() });
                    return;
                }

                let iceServers: RTCIceServer[] | undefined;
                const ice = this.storage.getItem('iceServers');
                if (ice) {
                    try {
                        iceServers = JSON.parse(ice);
                    }
                    catch (e) {
                        this.console.warn('invalid iceServers setting', e);
                    }
                }

                const offer: RTCSessionDescriptionInit = { type: 'offer', sdp: offerSdp };
                const session = new ViewerSession(offer, iceServers ? { iceServers } : undefined);
                await device.startRTCSignalingSession(session);
                const answer = await session.getAnswer();

                response.send(answer.sdp, { headers: this.addCors({ 'Content-Type': 'application/sdp' }) });
                return;
            }

            response.send('Not Found', { code: 404, headers: this.addCors() });
        }
        catch (e) {
            this.console.error('request error', e);
            response.send('Internal Server Error', { code: 500, headers: this.addCors() });
        }
    }
}

export default WebRTCBridge;
