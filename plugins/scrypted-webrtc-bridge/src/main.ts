import sdk, {
  HttpRequest,
  HttpRequestHandler,
  HttpResponse,
  Program,
  RTCSignalingChannel,
  RTCSignalingClient,
  RTCSignalingOptions,
  RTCSignalingSession,
  ScryptedDeviceBase,
  ScryptedInterface,
  Setting,
  SettingValue,
  Settings,
  RTCAVSignalingSetup,
  RTCConfiguration,
} from '@scrypted/sdk';
import { StorageSettings } from '@scrypted/sdk/storage-settings';
import { connectRTCSignalingClients } from '@scrypted/common/src/rtc-signaling';

const { systemManager, endpointManager } = sdk;

class WHEPViewerSession implements RTCSignalingSession {
  __proxy_props = { options: this.options };
  options: RTCSignalingOptions;
  offer: RTCSessionDescriptionInit;
  answer: RTCSessionDescriptionInit;

  constructor(offerSdp: string) {
    this.offer = { type: 'offer', sdp: offerSdp };
    this.options = {
      offer: this.offer,
      requiresAnswer: true,
      disableTrickle: true,
    };
  }

  async getOptions() {
    return this.options;
  }

  async createLocalDescription(type: 'offer' | 'answer', setup: RTCAVSignalingSetup) {
    if (type !== 'offer')
      throw new Error('only offer supported');
    return this.offer;
  }

  async setRemoteDescription(description: RTCSessionDescriptionInit) {
    this.answer = description;
  }

  async addIceCandidate() {
    // non-trickle, ignore
  }
}

export default class WebRTCBridge extends ScryptedDeviceBase implements HttpRequestHandler, Program, Settings {
  storageSettings = new StorageSettings(this, {
    iceServers: {
      title: 'ICE Servers',
      description: 'STUN/TURN server URLs',
      multiple: true,
    },
    allowedCameras: {
      title: 'Allowed Cameras',
      multiple: true,
      onGet: async () => ({ choices: this.getAllCameras().map(c => c.id) }),
    },
  });

  constructor(nativeId?: string) {
    super(nativeId);
    (async () => {
      const url = await endpointManager.getLocalEndpoint(this.nativeId, { public: true, insecure: true });
      this.console.log('WebRTC Bridge public endpoint:', url + 'public/');
    })();
  }

  async run(variables?: { [name: string]: any }): Promise<any> {
    return;
  }

  async getSettings(): Promise<Setting[]> {
    return this.storageSettings.getSettings();
  }

  async putSetting(key: string, value: SettingValue): Promise<void> {
    return this.storageSettings.putSetting(key, value);
  }

  getIceConfiguration(): RTCConfiguration | undefined {
    const servers: string[] = this.storageSettings.values.iceServers;
    if (servers?.length)
      return { iceServers: servers.map(url => ({ urls: url })) };
    return undefined;
  }

  getAllowedCameraIds(): string[] | undefined {
    const list: string[] = this.storageSettings.values.allowedCameras;
    return list?.length ? list : undefined;
  }

  getAllCameras() {
    const ret: { id: string; name: string; device: any }[] = [];
    const ids = Object.keys(systemManager.getSystemState());
    for (const id of ids) {
      const device = systemManager.getDeviceById(id);
      if (!device?.interfaces?.includes(ScryptedInterface.RTCSignalingChannel))
        continue;
      ret.push({ id, name: device.name, device });
    }
    return ret;
  }

  async listCameras(response: HttpResponse) {
    const allowed = this.getAllowedCameraIds();
    const devices = this.getAllCameras()
      .filter(d => !allowed || allowed.includes(d.id))
      .map(d => ({ id: d.id, name: d.name }));
    response.send(JSON.stringify(devices), { headers: { 'Content-Type': 'application/json' } });
  }

  async handleWHEP(request: HttpRequest, response: HttpResponse) {
    const url = new URL(request.url, 'http://localhost');
    const deviceId = url.searchParams.get('deviceId');
    const name = url.searchParams.get('name');
    let device: any;
    if (deviceId)
      device = systemManager.getDeviceById(deviceId);
    else if (name)
      device = this.getAllCameras().find(c => c.name === name)?.device;
    if (!device) {
      response.send('device not found', { code: 404 });
      return;
    }
    const allowed = this.getAllowedCameraIds();
    if (allowed && !allowed.includes(device.id)) {
      response.send('camera not allowed', { code: 403 });
      return;
    }
    if (!request.body) {
      response.send('empty body', { code: 400 });
      return;
    }
    const offer = request.body.toString();

    const viewerSession = new WHEPViewerSession(offer);

    try {
      if ((device as RTCSignalingClient).createRTCSignalingSession) {
        const cameraSession = await (device as RTCSignalingClient).createRTCSignalingSession();
        await connectRTCSignalingClients(
          this.console,
          viewerSession,
          { type: 'offer', audio: { direction: 'recvonly' }, video: { direction: 'recvonly' } },
          cameraSession,
          { type: 'answer', audio: { direction: 'sendonly' }, video: { direction: 'sendonly' }, configuration: this.getIceConfiguration() }
        );
      } else if ((device as RTCSignalingChannel).startRTCSignalingSession) {
        await (device as RTCSignalingChannel).startRTCSignalingSession(viewerSession);
      } else {
        throw new Error('device does not support WebRTC');
      }
    } catch (e) {
      this.console.error('negotiation failed', e);
      response.send('negotiation failed', { code: 500 });
      return;
    }

    response.send(viewerSession.answer?.sdp || '', { headers: { 'Content-Type': 'application/sdp' } });
  }

  async onRequest(request: HttpRequest, response: HttpResponse) {
    response.headers = response.headers || {};
    response.headers['Access-Control-Allow-Origin'] = '*';
    response.headers['Access-Control-Allow-Headers'] = '*';
    response.headers['Access-Control-Allow-Methods'] = 'GET,POST,OPTIONS';

    const path = request.url.split('?')[0];

    if (request.method === 'OPTIONS') {
      response.send('', { code: 200 });
      return;
    }

    if (request.method === 'GET' && path === '/public/health') {
      response.send(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
      return;
    }

    if (request.method === 'GET' && path === '/public/cameras') {
      await this.listCameras(response);
      return;
    }

    if (request.method === 'POST' && path === '/public/whep') {
      if (request.headers?.['content-type'] !== 'application/sdp') {
        response.send('content-type must be application/sdp', { code: 400 });
        return;
      }
      await this.handleWHEP(request, response);
      return;
    }

    response.send('not found', { code: 404 });
  }
}
