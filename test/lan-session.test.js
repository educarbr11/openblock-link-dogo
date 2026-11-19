const assert = require('assert');
const dgram = require('dgram');
const EventEmitter = require('events');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');

const OpenBlockLink = require('../src');
const LanSession = require('../src/session/lan');
const LanHub = require('../src/lan/hub');
const {decodePacket, isPacket, MULTICAST_ADDRESS} = require('../src/lan/protocol');
const fixture = require('./fixtures/lan-packet.json');

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const closeUdp = socket => new Promise(resolve => socket.close(resolve));
const freeUdpPort = async () => {
    const socket = dgram.createSocket('udp4');
    await new Promise(resolve => socket.bind(0, '127.0.0.1', resolve));
    const port = socket.address().port;
    await closeUdp(socket);
    return port;
};
const freeTcpPort = () => new Promise(resolve => {
    const server = http.createServer();
    server.listen(0, '127.0.0.1', () => {
        const port = server.address().port;
        server.close(() => resolve(port));
    });
});

const startLink = async udpPort => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dogoblock-lan-test-'));
    const link = new OpenBlockLink(directory, null, {lan: {
        port: udpPort,
        multicastInterface: '127.0.0.1'
    }});
    const port = await freeTcpPort();
    const ready = new Promise(resolve => link.once('ready', resolve));
    link.listen(port, '127.0.0.1');
    await ready;
    return {link, port, directory};
};

const stopLink = async server => {
    await new Promise(resolve => server.link._socketServer.close(resolve));
    await new Promise(resolve => server.link._httpServer.close(resolve));
    fs.rmSync(server.directory, {recursive: true, force: true});
};

const connect = (port, origin = 'http://localhost:8601') => new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/openblock/lan`, {origin});
    const events = new EventEmitter();
    const notifications = [];
    const pending = new Map();
    let nextId = 0;
    socket.on('error', reject);
    socket.on('message', data => {
        const message = JSON.parse(data);
        if (message.method === 'message') {
            notifications.push(message.params);
            events.emit('message', message.params);
        } else if (pending.has(message.id)) {
            const onResponse = pending.get(message.id);
            pending.delete(message.id);
            onResponse(message);
        } else {
            events.emit('response', message);
        }
    });
    socket.once('open', () => resolve({
        socket,
        notifications,
        events,
        request: (method, params) => new Promise((onResponse, onTimeout) => {
            const id = nextId++;
            const timeout = setTimeout(() => onTimeout(new Error(`RPC timeout: ${method}`)), 1500);
            pending.set(id, response => {
                clearTimeout(timeout);
                onResponse(response);
            });
            socket.send(JSON.stringify({jsonrpc: '2.0', id, method, params}));
        })
    }));
});

const closeClient = client => new Promise(resolve => {
    if (client.socket.readyState === WebSocket.CLOSED) return resolve();
    client.socket.once('close', resolve);
    client.socket.close();
});

const waitForMessage = (client, message) => new Promise((resolve, reject) => {
    const found = client.notifications.find(item => item.message === message);
    if (found) return resolve(found);
    const waiting = {timeout: null};
    const onMessage = item => {
        if (item.message !== message) return;
        clearTimeout(waiting.timeout);
        client.events.removeListener('message', onMessage);
        resolve(item);
    };
    waiting.timeout = setTimeout(() => {
        client.events.removeListener('message', onMessage);
        reject(new Error(`Missing LAN message: ${message}`));
    }, 1500);
    client.events.on('message', onMessage);
});

const sendRaw = (client, text) => new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Malformed request did not receive an error.')), 1500);
    client.events.once('response', response => {
        clearTimeout(timeout);
        resolve(response);
    });
    client.socket.send(text);
});

const sendUdp = (socket, port, packet) => new Promise((resolve, reject) => {
    const bytes = typeof packet === 'string' ? Buffer.from(packet) : Buffer.from(JSON.stringify(packet));
    socket.send(bytes, port, MULTICAST_ADDRESS, error => {
        if (error) reject(error);
        else resolve();
    });
});

const testProtocol = () => {
    assert.ok(isPacket(fixture));
    assert.deepStrictEqual(decodePacket(Buffer.from(JSON.stringify(fixture))), fixture);
    for (const invalid of [null, [], {}, Object.assign({}, fixture, {version: 2}),
        Object.assign({}, fixture, {channel: 17}), Object.assign({}, fixture, {channel: '6'}),
        Object.assign({}, fixture, {message: '  '}), Object.assign({}, fixture, {message: '🎮'.repeat(129)}),
        Object.assign({}, fixture, {value: '🎮'.repeat(1025)}), Object.assign({}, fixture, {sender: '../sender'}),
        Object.assign({}, fixture, {id: ''})]) {
        assert.strictEqual(isPacket(invalid), false, JSON.stringify(invalid));
    }
    assert.ok(isPacket(Object.assign({}, fixture, {message: '🎮'.repeat(128), value: '🎮'.repeat(1024)})));
    assert.strictEqual(decodePacket(Buffer.alloc(8193, ' ')), null);
    assert.strictEqual(decodePacket(Buffer.from('not json')), null);
    const request = origin => ({socket: {remoteAddress: '127.0.0.1'}, headers: {origin}});
    for (const origin of ['https://dogoblock.vercel.app', 'tauri://localhost', 'http://tauri.localhost', 'null']) {
        assert.strictEqual(LanSession.verifyRequest(request(origin)), null);
    }
    assert.ok(LanSession.verifyRequest(request('https://evil.example')));
    assert.ok(LanSession.verifyRequest({socket: {remoteAddress: '192.168.0.2'}, headers: {origin: 'null'}}));
    assert.ok(LanSession.verifyRequest({socket: {remoteAddress: '::ffff:192.168.0.2'}, headers: {origin: 'null'}}));
};

const testRateAndDedupBounds = async () => {
    const socket = new EventEmitter();
    socket.readyState = 0;
    socket.OPEN = 1;
    const session = new LanSession(socket, null, null, null, {
        join: () => Promise.resolve(),
        leave: () => {},
        broadcast: () => Promise.resolve()
    });
    const originalNow = Date.now;
    try {
        Date.now = () => 10000;
        await session._call('join', {channel: 6});
        for (let index = 0; index < 100; index++) await session._call('broadcast', {message: 'hello', value: ''});
        await assert.rejects(() => session._call('broadcast', {message: 'hello', value: ''}), /rate limit/);
        Date.now = () => 11000;
        await session._call('broadcast', {message: 'hello', value: ''});
        const hub = new LanHub();
        for (let index = 0; index < 3000; index++) {
            hub._receive(Buffer.from(JSON.stringify(Object.assign({}, fixture, {id: `packet-${index}`}))));
        }
        assert.ok(hub._seen.size <= 2048, 'Received IDs must not grow without bounds.');
    } finally {
        Date.now = originalNow;
        session.dispose();
    }
};

const testRealSessions = async () => {
    const udpPort = await freeUdpPort();
    const servers = [await startLink(udpPort), await startLink(udpPort)];
    const clients = [];
    const udp = dgram.createSocket('udp4');
    try {
        assert.strictEqual(servers[0].link._lanHub._socket, null, 'LAN socket is lazy.');
        const sender = await connect(servers[0].port);
        const receiver = await connect(servers[0].port);
        const otherChannel = await connect(servers[0].port);
        const peer = await connect(servers[1].port, 'tauri://localhost');
        clients.push(sender, receiver, otherChannel, peer);
        assert.strictEqual(servers[0].link._lanHub._socket, null, 'Opening the editor socket does not start UDP.');
        const beforeJoin = await sender.request('broadcast', {message: 'hello', value: ''});
        assert.ok(beforeJoin.error.message.includes('Join'));
        assert.deepStrictEqual((await sender.request('join', {})).result, {channel: 6});
        assert.deepStrictEqual((await receiver.request('join', {channel: 6})).result, {channel: 6});
        assert.deepStrictEqual((await peer.request('join', {channel: 6})).result, {channel: 6});
        await otherChannel.request('join', {channel: 7});

        const result = await sender.request('broadcast', {message: 'ação 🎮', value: '23.5'});
        assert.deepStrictEqual(result.result, {sent: true});
        assert.deepStrictEqual(await waitForMessage(receiver, 'ação 🎮'), {
            channel: 6, message: 'ação 🎮', value: '23.5'
        });
        assert.deepStrictEqual(await waitForMessage(peer, 'ação 🎮'), {channel: 6, message: 'ação 🎮', value: '23.5'});
        await pause(80);
        assert.strictEqual(receiver.notifications.length, 1, 'Local fanout and multicast loopback must not duplicate.');
        assert.strictEqual(peer.notifications.length, 1);
        assert.strictEqual(sender.notifications.length, 0, 'The sending editor does not receive its own message.');
        assert.strictEqual(otherChannel.notifications.length, 0);

        for (const channel of [0, 17, 1.5, '6']) {
            assert.strictEqual((await receiver.request('join', {channel})).error.code, -32602);
        }
        for (const params of [{message: '', value: ''}, {message: ' ', value: ''},
            {message: 'x'.repeat(129), value: ''}, {message: 'valid', value: 'x'.repeat(1025)},
            {message: 'valid', value: 2}]) {
            assert.strictEqual((await sender.request('broadcast', params)).error.code, -32602);
        }
        assert.strictEqual((await sendRaw(sender, '{')).error.code, -32700);
        assert.strictEqual((await sendRaw(sender, '[]')).error.code, -32600);
        assert.strictEqual((await sendRaw(sender, JSON.stringify({jsonrpc: '2.0', method: 'join', id: {bad: true}})))
            .error.code, -32600);
        assert.strictEqual((await sendRaw(sender, ' '.repeat(8193))).error.code, -32600);
        assert.strictEqual((await sender.request('unknown', {})).error.code, -32601);
        assert.deepStrictEqual((await sender.request('join', {channel: 6})).result, {channel: 6});

        await new Promise(resolve => udp.bind(0, '127.0.0.1', resolve));
        udp.setMulticastInterface('127.0.0.1');
        udp.setMulticastTTL(1);
        await sendUdp(udp, udpPort, fixture);
        await sendUdp(udp, udpPort, fixture);
        await waitForMessage(receiver, fixture.message);
        await waitForMessage(peer, fixture.message);
        await pause(80);
        assert.strictEqual(receiver.notifications.filter(item => item.message === fixture.message).length, 1);
        assert.strictEqual(peer.notifications.filter(item => item.message === fixture.message).length, 1);
        const previousCount = receiver.notifications.length;
        await sendUdp(udp, udpPort, 'not json');
        await sendUdp(udp, udpPort, Object.assign({}, fixture, {id: 'invalid', channel: 17}));
        await sendUdp(udp, udpPort, ' '.repeat(8193));
        await pause(80);
        assert.strictEqual(receiver.notifications.length, previousCount, 'Malformed UDP must be ignored.');
        await sendUdp(udp, udpPort, Object.assign({}, fixture, {
            id: 'channel-7', channel: 7, message: 'channel seven'
        }));
        assert.strictEqual((await waitForMessage(otherChannel, 'channel seven')).channel, 7);
        await receiver.request('join', {channel: 7});
        await otherChannel.request('broadcast', {message: 'changed channel', value: ''});
        assert.strictEqual((await waitForMessage(receiver, 'changed channel')).value, '');

        const blocked = new WebSocket(`ws://127.0.0.1:${servers[0].port}/openblock/lan`, {origin: 'https://evil.example'});
        const closeCode = await new Promise((resolve, reject) => {
            blocked.once('close', resolve);
            blocked.once('error', reject);
        });
        assert.strictEqual(closeCode, 1008);
    } finally {
        if (udp.address) {
            try {
                await closeUdp(udp);
            } catch (error) {
                // Setup failures may happen before binding the helper sender.
            }
        }
        await Promise.all(clients.map(closeClient));
        await pause(20);
        servers.forEach(server => {
            assert.strictEqual(server.link._lanHub._socket, null, 'Last editor closes UDP.');
            assert.strictEqual(server.link._lanHub._clients.size, 0);
        });
        await Promise.all(servers.map(stopLink));
    }
};

const testUnavailableUdp = async () => {
    const blocker = dgram.createSocket('udp4');
    await new Promise(resolve => blocker.bind(0, '0.0.0.0', resolve));
    const server = await startLink(blocker.address().port);
    let client;
    try {
        client = await connect(server.port);
        const response = await client.request('join', {channel: 6});
        assert.ok(response.error, 'An unavailable UDP port returns an RPC error rather than hanging.');
        assert.strictEqual(server.link._lanHub._socket, null);
    } finally {
        if (client) await closeClient(client);
        await stopLink(server);
        await closeUdp(blocker);
    }
};

(async () => {
    testProtocol();
    await testRateAndDedupBounds();
    await testRealSessions();
    await testUnavailableUdp();
    console.log('LAN protocol, WebSocket, multicast, channel isolation, rate limits and cleanup tests passed.');
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
