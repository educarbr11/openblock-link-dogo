const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');

const OpenBlockLink = require('../src/index');
const CompilerSession = require('../src/session/compiler');

const BLINK_CODE = `void setup() {
  pinMode(13, OUTPUT);
}

void loop() {
  digitalWrite(13, HIGH);
  delay(500);
  digitalWrite(13, LOW);
  delay(500);
}
`;

const getFreePort = () => new Promise(resolve => {
    const server = http.createServer();
    server.listen(0, '127.0.0.1', () => {
        const {port} = server.address();
        server.close(() => resolve(port));
    });
});

const startLink = async toolsPath => {
    const link = new OpenBlockLink(fs.mkdtempSync(path.join(os.tmpdir(), 'openblock-link-test-')), toolsPath);
    const port = await getFreePort();
    const ready = new Promise(resolve => link.on('ready', resolve));
    link.listen(port, '127.0.0.1');
    await ready;
    return {link, port};
};

const stopLink = link => new Promise(resolve => link._httpServer.close(resolve));

const compileRequest = (port, origin, params) => new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/openblock/compiler`, {origin});
    const stdout = [];
    socket.on('open', () => {
        socket.send(JSON.stringify({jsonrpc: '2.0', id: 1, method: 'compile', params}));
    });
    socket.on('message', data => {
        const message = JSON.parse(data);
        if (message.method === 'compileStdout') {
            stdout.push(message.params.message);
            return;
        }
        socket.close();
        resolve(Object.assign({stdout: stdout.join('')}, message));
    });
    socket.on('close', code => resolve({closeCode: code}));
    socket.on('error', reject);
});

const testOriginPatterns = () => {
    const matches = CompilerSession.matchesOriginPattern;
    assert.strictEqual(matches('https://dogoblock.dogomaker.com', 'https://*.dogomaker.com'), true);
    assert.strictEqual(matches('https://dogomaker.com', 'https://*.dogomaker.com'), false);
    assert.strictEqual(matches('https://evildogomaker.com', 'https://*.dogomaker.com'), false);
    assert.strictEqual(matches('http://dogoblock.dogomaker.com', 'https://*.dogomaker.com'), false);
    assert.strictEqual(matches('http://localhost:8601', 'http://localhost:*'), true);
    assert.strictEqual(matches('http://localhost', 'http://localhost:*'), true);
    assert.strictEqual(matches('http://localhost:8601', 'http://localhost:3000'), false);
    assert.strictEqual(matches('null', 'http://localhost:*'), false);
};

const testRejectsUnknownOrigin = async () => {
    const {link, port} = await startLink(fs.mkdtempSync(path.join(os.tmpdir(), 'openblock-tools-')));
    for (const origin of ['https://example.com', 'https://evil.vercel.app', 'https://dogoblock-git-main.vercel.app']) {
        const response = await compileRequest(port, origin, {board: 'arduinoUno', code: BLINK_CODE});
        assert.strictEqual(response.closeCode, 1008, origin);
    }
    await stopLink(link);
};

const testReportsMissingCompiler = async () => {
    const {link, port} = await startLink(fs.mkdtempSync(path.join(os.tmpdir(), 'openblock-tools-')));
    const response = await compileRequest(port, 'http://localhost:8601', {board: 'arduinoUno', code: BLINK_CODE});
    assert.ok(response.error.message.includes('compilador Arduino offline'));
    const production = await compileRequest(port, 'https://dogoblock.vercel.app', {board: 'arduinoUno', code: BLINK_CODE});
    assert.ok(production.error.message.includes('compilador Arduino offline'));
    const unknownBoard = await compileRequest(port, 'http://localhost:8601', {board: 'esp32', code: BLINK_CODE});
    assert.ok(unknownBoard.error.message.includes('nao suporta a placa esp32'));
    await stopLink(link);
};

// Compiling needs the Arduino toolchain in ./tools (npm run fetch), so it only runs on request.
const testCompilesWithLocalToolchain = async () => {
    if (process.env.OPENBLOCK_LINK_COMPILER_TEST !== '1') {
        console.log('Skipping local Arduino build (set OPENBLOCK_LINK_COMPILER_TEST=1 to run it).');
        return;
    }
    const {link, port} = await startLink(path.join(__dirname, '../tools'));
    const response = await compileRequest(port, 'http://localhost:8601', {board: 'arduinoUno', code: BLINK_CODE});
    assert.ifError(response.error && response.error.message);
    assert.strictEqual(response.result.fqbn, 'arduino:avr:uno');
    assert.ok(response.result.hex.startsWith(':'));
    assert.ok(response.result.hex.trim().endsWith(':00000001FF'));
    await stopLink(link);
};

(async () => {
    testOriginPatterns();
    await testRejectsUnknownOrigin();
    await testReportsMissingCompiler();
    await testCompilesWithLocalToolchain();
    console.log('Compiler session tests passed.');
})().catch(error => {
    console.error(error);
    process.exit(1);
});
