const crypto = require('crypto');
const dgram = require('dgram');

const {PROTOCOL, VERSION, MULTICAST_ADDRESS, PORT, decodePacket} = require('./protocol');

const MAX_SEEN_PACKETS = 2048;
const SEEN_PACKET_LIFETIME_MS = 30000;
const MAX_RECEIVED_PER_SECOND = 100;

/** One lazily opened multicast socket serves all local editor sessions. */
class LanHub {
    constructor (options = {}) {
        this._port = options.port || PORT;
        this._address = options.multicastAddress || MULTICAST_ADDRESS;
        this._interface = options.multicastInterface;
        this._clients = new Map();
        this._seen = new Map();
        this._socket = null;
        this._starting = null;
        this._receivedWindow = 0;
        this._receivedCount = 0;
    }

    async join (client, channel) {
        this._clients.set(client, channel);
        try {
            await this._open();
        } catch (error) {
            this.leave(client);
            throw error;
        }
        if (!this._clients.has(client)) throw new Error('LAN session was closed.');
    }

    leave (client) {
        this._clients.delete(client);
        if (!this._clients.size) this._close();
    }

    _open () {
        if (this._starting) return this._starting;
        if (this._socket) return Promise.resolve();
        const socket = dgram.createSocket({type: 'udp4', reuseAddr: true});
        this._socket = socket;
        const starting = new Promise((resolve, reject) => {
            let ready = false;
            socket.on('message', bytes => {
                if (this._socket === socket) this._receive(bytes);
            });
            socket.on('error', error => {
                if (ready) this._fail(socket, error);
                else reject(error);
            });
            socket.once('close', () => {
                if (!ready) reject(new Error('LAN socket was closed.'));
            });
            socket.bind(this._port, '0.0.0.0', () => {
                if (this._socket !== socket || !this._clients.size) {
                    reject(new Error('LAN session was closed.'));
                    return;
                }
                try {
                    socket.addMembership(this._address, this._interface);
                    socket.setMulticastTTL(1);
                    socket.setMulticastLoopback(true);
                    if (this._interface) socket.setMulticastInterface(this._interface);
                    ready = true;
                    resolve();
                } catch (error) {
                    reject(error);
                }
            });
        });
        this._starting = starting;
        starting.then(() => {
            if (this._starting === starting) this._starting = null;
        }, () => {
            if (this._socket === socket) this._close();
        });
        return starting;
    }

    _close () {
        const socket = this._socket;
        this._socket = null;
        this._starting = null;
        this._seen.clear();
        if (!socket) return;
        try {
            socket.close();
        } catch (error) {
            // The last editor may leave before the UDP bind has completed.
        }
    }

    _fail (socket, error) {
        if (this._socket !== socket) return;
        const clients = Array.from(this._clients.keys());
        this._clients.clear();
        this._close();
        clients.forEach(client => client.onError(error));
    }

    _remember (packet) {
        const now = Date.now();
        for (const [key, expires] of this._seen) {
            if (expires > now) break;
            this._seen.delete(key);
        }
        const key = `${packet.sender}:${packet.id}`;
        if (this._seen.has(key)) return false;
        this._seen.set(key, now + SEEN_PACKET_LIFETIME_MS);
        if (this._seen.size > MAX_SEEN_PACKETS) this._seen.delete(this._seen.keys().next().value);
        return true;
    }

    _receive (bytes) {
        const packet = decodePacket(bytes);
        if (!packet || !this._remember(packet)) return;
        const now = Date.now();
        if (now - this._receivedWindow >= 1000) {
            this._receivedWindow = now;
            this._receivedCount = 0;
        }
        if (++this._receivedCount > MAX_RECEIVED_PER_SECOND) return;
        this._deliver(packet);
    }

    _deliver (packet) {
        this._clients.forEach((channel, client) => {
            if (channel === packet.channel && client.sender !== packet.sender) {
                client.onMessage({channel, message: packet.message, value: packet.value});
            }
        });
    }

    async broadcast (client, message, value) {
        const channel = this._clients.get(client);
        if (!channel || !this._socket || this._starting) throw new Error('Join a LAN channel before broadcasting.');
        const packet = {
            protocol: PROTOCOL,
            version: VERSION,
            id: crypto.randomBytes(16).toString('hex'),
            sender: client.sender,
            channel,
            message,
            value
        };
        // Reserve the ID before sending: multicast loopback can arrive before send completes.
        this._remember(packet);
        const socket = this._socket;
        try {
            await new Promise((resolve, reject) => socket.send(
                Buffer.from(JSON.stringify(packet)), this._port, this._address,
                error => {
                    if (error) reject(error);
                    else resolve();
                }
            ));
        } catch (error) {
            this._seen.delete(`${packet.sender}:${packet.id}`);
            throw error;
        }
        this._deliver(packet);
    }
}

module.exports = LanHub;
