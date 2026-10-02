const assert = require('assert');

const Arduino = require('../src/upload/arduino');

const getUploadFqbns = config => {
    const uploader = Object.create(Arduino.prototype);
    uploader._config = config;
    return uploader._getUploadFqbns();
};

const testUploadProfiles = () => {
    assert.deepStrictEqual(
        getUploadFqbns({fqbn: 'arduino:avr:nano'}),
        ['arduino:avr:nano', 'arduino:avr:nano:cpu=atmega328old']
    );

    assert.deepStrictEqual(
        getUploadFqbns({fqbn: 'arduino:avr:nano:cpu=atmega328old'}),
        ['arduino:avr:nano:cpu=atmega328old', 'arduino:avr:nano']
    );

    assert.deepStrictEqual(
        getUploadFqbns({
            fqbn: 'arduino:avr:nano',
            uploadFallbackFqbns: ['arduino:avr:nano:cpu=atmega328old']
        }),
        ['arduino:avr:nano', 'arduino:avr:nano:cpu=atmega328old']
    );

    assert.deepStrictEqual(
        getUploadFqbns({fqbn: 'arduino:avr:uno'}),
        ['arduino:avr:uno']
    );

    const uploader = Object.create(Arduino.prototype);
    uploader._config = {fqbn: 'arduino:avr:nano'};
    uploader._savedUploadFqbn = 'arduino:avr:nano:cpu=atmega328old';
    uploader._sendstd = () => {};
    assert.deepStrictEqual(
        uploader._getUploadFqbns(),
        ['arduino:avr:nano:cpu=atmega328old', 'arduino:avr:nano']
    );
};

const testNanoRetriesWithOldBootloader = async () => {
    const attempts = [];
    const uploader = Object.create(Arduino.prototype);
    uploader._abort = false;
    uploader._config = {fqbn: 'arduino:avr:nano'};
    uploader._sendstd = () => {};
    uploader._uploadProfileStore = {
        savePreferredFqbn: (peripheral, fqbn) => {
            assert.deepStrictEqual(peripheral, {path: '/dev/ttyUSB0'});
            assert.strictEqual(fqbn, 'arduino:avr:nano:cpu=atmega328old');
            return true;
        }
    };
    uploader._peripheralInfo = {path: '/dev/ttyUSB0'};
    uploader._flashHexWithAvrdude = fqbn => {
        attempts.push(fqbn);
        if (fqbn === 'arduino:avr:nano') {
            return Promise.reject(new Error('avrdude failed to flash'));
        }
        return Promise.resolve('Success');
    };

    const result = await uploader.flashArtifact('/tmp/code.hex');

    assert.strictEqual(result, 'Success');
    assert.deepStrictEqual(attempts, [
        'arduino:avr:nano',
        'arduino:avr:nano:cpu=atmega328old'
    ]);
    assert.strictEqual(uploader._savedUploadFqbn, 'arduino:avr:nano:cpu=atmega328old');
};

const testNanoReplacesOutdatedSavedProfile = async () => {
    const savedProfiles = [];
    const uploader = Object.create(Arduino.prototype);
    uploader._abort = false;
    uploader._config = {fqbn: 'arduino:avr:nano'};
    uploader._savedUploadFqbn = 'arduino:avr:nano:cpu=atmega328old';
    uploader._reportedSavedUploadProfile = false;
    uploader._sendstd = () => {};
    uploader._peripheralInfo = {path: '/dev/ttyUSB0'};
    uploader._uploadProfileStore = {
        savePreferredFqbn: (peripheral, fqbn) => {
            savedProfiles.push({peripheral, fqbn});
            return true;
        }
    };
    uploader._flashHexWithAvrdude = fqbn => fqbn === 'arduino:avr:nano:cpu=atmega328old' ?
        Promise.reject(new Error('avrdude failed to flash')) : Promise.resolve('Success');

    assert.strictEqual(await uploader.flashArtifact('/tmp/code.hex'), 'Success');
    assert.deepStrictEqual(savedProfiles, [{
        peripheral: {path: '/dev/ttyUSB0'},
        fqbn: 'arduino:avr:nano'
    }]);
    assert.strictEqual(uploader._savedUploadFqbn, 'arduino:avr:nano');
};

const testNanoSyncAttemptLimit = () => {
    const uploader = Object.create(Arduino.prototype);
    const nanoOutput = [
        'avrdude: stk500_getsync() attempt 1 of 10: not in sync: resp=0x00',
        'avrdude: stk500_getsync() attempt 2 of 10: not in sync: resp=0x00',
        'avrdude: stk500_getsync() attempt 3 of 10: not in sync: resp=0x00'
    ].join('\n');

    assert.strictEqual(
        uploader._hasReachedAvrdudeSyncAttemptLimit('arduino:avr:nano', nanoOutput),
        true
    );
    assert.strictEqual(
        uploader._hasReachedAvrdudeSyncAttemptLimit(
            'arduino:avr:nano',
            nanoOutput.replace('attempt 3', 'attempt 2')
        ),
        false
    );
    assert.strictEqual(
        uploader._hasReachedAvrdudeSyncAttemptLimit('arduino:avr:uno', nanoOutput),
        false
    );
    assert.ok(uploader._formatAvrdudeSyncAttempts('arduino:avr:nano', nanoOutput).includes('attempt 3 of 3'));
    assert.ok(uploader._formatAvrdudeSyncAttempts('arduino:avr:uno', nanoOutput).includes('attempt 3 of 10'));
};

(async () => {
    testUploadProfiles();
    await testNanoRetriesWithOldBootloader();
    await testNanoReplacesOutdatedSavedProfile();
    testNanoSyncAttemptLimit();
    console.log('Arduino upload profile tests passed.');
})().catch(error => {
    console.error(error);
    process.exit(1);
});
