const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ArduinoUploadProfileStore = require('../src/upload/arduino-upload-profile-store');
const {createPeripheralKey} = ArduinoUploadProfileStore;

const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'dogoblock-nano-profile-'));

try {
    const store = new ArduinoUploadProfileStore(temporaryDirectory);
    const nano = {
        path: '/dev/ttyUSB0',
        vendorId: '1a86',
        productId: '7523',
        pnpId: 'usb-1a86_USB2.0-Serial-if00-port0'
    };
    const oldBootloader = 'arduino:avr:nano:cpu=atmega328old';

    assert.strictEqual(store.getPreferredFqbn(nano), null);
    assert.strictEqual(store.savePreferredFqbn(nano, oldBootloader), true);
    assert.strictEqual(store.getPreferredFqbn(nano), oldBootloader);

    assert.notStrictEqual(
        createPeripheralKey(nano),
        createPeripheralKey(Object.assign({}, nano, {path: '/dev/ttyUSB1'}))
    );
    assert.strictEqual(
        createPeripheralKey(Object.assign({}, nano, {serialNumber: 'NANO-123'})),
        createPeripheralKey(Object.assign({}, nano, {path: '/dev/ttyUSB9', serialNumber: 'NANO-123'}))
    );

    const profilePath = path.join(temporaryDirectory, 'arduino', 'upload-profiles.json');
    fs.writeFileSync(profilePath, '{invalid json');
    assert.strictEqual(store.getPreferredFqbn(nano), null);
    assert.strictEqual(store.savePreferredFqbn(nano, 'arduino:avr:nano'), true);
    assert.strictEqual(store.getPreferredFqbn(nano), 'arduino:avr:nano');
} finally {
    fs.rmSync(temporaryDirectory, {recursive: true, force: true});
}

console.log('Arduino upload profile store tests passed.');
