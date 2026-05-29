const assert = require('assert');
const http = require('http');
const WebSocket = require('ws');

const OpenBlockLink = require('../src/index');
const BLESession = require('../src/session/ble');

const makeSocket = () => ({
    OPEN: 1,
    readyState: 1,
    addListener: () => {},
    removeListener: () => {},
    close: () => {},
    send: () => {}
});

const listen = server => new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
});

const close = server => new Promise(resolve => server.close(resolve));

const getFreePort = async () => {
    const server = http.createServer();
    const port = await listen(server);
    await close(server);
    return port;
};

const testBluezMicrobitNameMatch = () => {
    const session = new BLESession(makeSocket(), '/tmp/openblock-link-test');
    session._listAll = false;
    session._scanServices = ['e95d0753251d470aa062fa1922dfa9a8'];

    assert.strictEqual(session._bluezMatchesDevice({
        name: 'BBC micro:bit [zapev]',
        serviceUuids: []
    }), true);

    assert.strictEqual(session._bluezMatchesDevice({
        name: 'Baseus AirGo AS01',
        serviceUuids: []
    }), false);
};

const testBleWebSocketRoute = async () => {
    const link = new OpenBlockLink('/tmp/openblock-link-test');
    const port = await getFreePort();
    const ready = new Promise(resolve => {
        link.on('ready', resolve);
    });
    link.listen(port, '127.0.0.1');
    await ready;

    await new Promise((resolve, reject) => {
        const socket = new WebSocket(`ws://127.0.0.1:${port}/openblock/ble`);
        socket.on('open', () => {
            socket.close();
            resolve();
        });
        socket.on('error', reject);
    });

    await close(link._httpServer);
};

const testInvalidServerDetection = async () => {
    const server = http.createServer((_req, res) => {
        res.writeHead(200, {'Content-Type': 'text/plain'});
        res.end('not-openblock-link-server');
    });
    const port = await listen(server);
    const link = new OpenBlockLink('/tmp/openblock-link-test');
    const isSame = await link.isSameServer('127.0.0.1', port);
    assert.strictEqual(isSame, false);
    await close(server);
};

(async () => {
    testBluezMicrobitNameMatch();
    await testBleWebSocketRoute();
    await testInvalidServerDetection();
})().catch(error => {
    console.error(error);
    process.exit(1);
});
