const crypto = require('crypto');

const Session = require('./session');
const CompilerSession = require('./compiler');
const LanHub = require('../lan/hub');
const {DEFAULT_CHANNEL, MAX_PACKET_BYTES, isChannel, isMessage, isValue} = require('../lan/protocol');

const MAX_MESSAGES_PER_SECOND = 100;
const DEFAULT_ALLOWED_ORIGINS = [
    'https://dogoblock.vercel.app',
    'https://dogomaker.com',
    'https://*.dogomaker.com',
    'http://localhost:*',
    'http://127.0.0.1:*',
    'tauri://localhost',
    'http://tauri.localhost',
    'https://tauri.localhost',
    'file://',
    'null'
];

class LanSession extends Session {
    static verifyRequest (request) {
        const address = request.socket.remoteAddress || '';
        if (address !== '::1' && !/^(::ffff:)?127\./.test(address)) return 'LAN clients must connect over loopback.';
        const configured = process.env.OPENBLOCK_LINK_LAN_ORIGINS;
        const allowed = configured ? configured.split(',').map(origin => origin.trim())
            .filter(Boolean) :
            DEFAULT_ALLOWED_ORIGINS;
        const origin = request.headers.origin;
        const matches = CompilerSession.matchesOriginPattern;
        if (!origin || !allowed.some(pattern => pattern === origin || matches(origin, pattern))) {
            return 'This editor origin is not allowed to use LAN.';
        }
        return null;
    }

    constructor (socket, userDataPath, toolsPath, toolsProvider, hub) {
        super(socket);
        this._hub = hub || new LanHub();
        this._disposed = false;
        this._joined = false;
        this._sendWindow = 0;
        this._sendCount = 0;
        this._client = {
            sender: crypto.randomBytes(16).toString('hex'),
            onMessage: params => this.sendRemoteRequest('message', params),
            onError: () => {
                if (this._socket) this._socket.close(1011, 'LAN connection failed');
            }
        };
    }

    dispose () {
        if (this._disposed) return;
        this._disposed = true;
        this._hub.leave(this._client);
        super.dispose();
    }

    didReceiveMessage (message, sendResponseText) {
        const send = (id, result, error) => {
            if (this._disposed || !this._socket || this._socket.readyState !== this._socket.OPEN) return;
            sendResponseText(JSON.stringify(this.makeResponse(id, result, error)));
        };
        if (Buffer.byteLength(message) > MAX_PACKET_BYTES) {
            send(null, null, {code: -32600, message: 'LAN request is too large.'});
            return;
        }
        let request;
        try {
            request = JSON.parse(message);
        } catch (error) {
            send(null, null, {code: -32700, message: 'Invalid JSON.'});
            return;
        }
        if (!request || Array.isArray(request) || request.jsonrpc !== '2.0' || typeof request.method !== 'string') {
            send(null, null, {code: -32600, message: 'Invalid JSON-RPC request.'});
            return;
        }
        const hasId = Object.prototype.hasOwnProperty.call(request, 'id');
        if (hasId && request.id !== null && typeof request.id !== 'string' &&
            (typeof request.id !== 'number' || !Number.isFinite(request.id))) {
            send(null, null, {code: -32600, message: 'Invalid JSON-RPC request ID.'});
            return;
        }
        Promise.resolve().then(() => this._call(request.method, request.params))
            .then(
                result => {
                    if (hasId) send(request.id, result, null);
                },
                error => {
                    if (hasId) send(request.id, null, {code: error.code || -32000, message: error.message});
                }
            );
    }

    async _call (method, params = {}) {
        if (this._disposed) throw new Error('LAN session was closed.');
        if (!params || typeof params !== 'object' || Array.isArray(params)) {
            throw Object.assign(new Error('LAN parameters must be an object.'), {code: -32602});
        }
        if (method === 'join') {
            const channel = typeof params.channel === 'undefined' ? DEFAULT_CHANNEL : params.channel;
            if (!isChannel(channel)) {
                throw Object.assign(new Error('LAN channel must be between 1 and 16.'), {code: -32602});
            }
            await this._hub.join(this._client, channel);
            this._joined = true;
            return {channel};
        }
        if (method === 'broadcast') {
            if (!this._joined) throw new Error('Join a LAN channel before broadcasting.');
            if (!isMessage(params.message) || !isValue(params.value)) {
                throw Object.assign(new Error('Invalid LAN message or value.'), {code: -32602});
            }
            const now = Date.now();
            if (now - this._sendWindow >= 1000) {
                this._sendWindow = now;
                this._sendCount = 0;
            }
            if (++this._sendCount > MAX_MESSAGES_PER_SECOND) throw new Error('LAN message rate limit exceeded.');
            await this._hub.broadcast(this._client, params.message, params.value);
            return {sent: true};
        }
        throw Object.assign(new Error(`Method not found: ${method}`), {code: -32601});
    }
}

module.exports = LanSession;
