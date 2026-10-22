const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const Arduino = require('../src/upload/arduino');

// A fake arduino-cli that records each call and fails, so setup errors are cached.
const makeTools = () => {
    const toolsPath = fs.mkdtempSync(path.join(os.tmpdir(), 'arduino-cli-lazy-'));
    const callsFile = path.join(toolsPath, 'calls.log');
    fs.mkdirSync(path.join(toolsPath, 'Arduino'));
    const cli = path.join(toolsPath, 'Arduino', 'arduino-cli');
    fs.writeFileSync(cli, `#!/bin/sh\necho "$@" >> "${callsFile}"\nexit 1\n`);
    fs.chmodSync(cli, 0o755);
    const calls = () => {
        if (!fs.existsSync(callsFile)) return [];
        return fs.readFileSync(callsFile, 'utf8').trim()
            .split('\n');
    };
    return {toolsPath, calls};
};

(async () => {
    if (os.platform() === 'win32') {
        console.log('Skipping arduino-cli lazy init test on Windows.');
        return;
    }
    const {toolsPath, calls} = makeTools();
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'arduino-cli-lazy-data-'));
    const uploader = new Arduino('/dev/null', {fqbn: 'arduino:avr:uno', library: []}, userData, toolsPath,
        () => {});

    // Uploading a compiled artifact only needs avrdude, so creating the uploader runs nothing.
    assert.deepStrictEqual(calls(), []);

    await assert.rejects(uploader.build('void setup() {}\nvoid loop() {}\n'), /config initialization failed/);
    assert.strictEqual(calls().length, 1);

    // A failed setup is not retried on every build.
    await assert.rejects(uploader.build('void setup() {}\nvoid loop() {}\n'), /config initialization failed/);
    assert.strictEqual(calls().length, 1);

    console.log('Arduino CLI lazy init tests passed.');
})().catch(error => {
    console.error(error);
    process.exit(1);
});
