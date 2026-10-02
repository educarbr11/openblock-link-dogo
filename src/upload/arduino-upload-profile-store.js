const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PROFILE_SCHEMA_VERSION = 1;
const MAX_SAVED_PROFILES = 50;

const normalizeIdentityPart = value => String(value || '').trim()
    .toUpperCase();

const createPeripheralKey = peripheral => {
    const device = peripheral || {};
    const vendorId = normalizeIdentityPart(device.vendorId);
    const productId = normalizeIdentityPart(device.productId);
    const serialNumber = normalizeIdentityPart(device.serialNumber);
    const identityParts = serialNumber ?
        ['serial', vendorId, productId, serialNumber] :
        [
            'port',
            vendorId,
            productId,
            normalizeIdentityPart(device.pnpId),
            normalizeIdentityPart(device.locationId),
            normalizeIdentityPart(device.path)
        ];

    if (!identityParts.slice(1).some(Boolean)) return null;
    return crypto.createHash('sha256').update(identityParts.join('|'))
        .digest('hex');
};

class ArduinoUploadProfileStore {
    constructor (userDataPath) {
        this._filePath = path.join(userDataPath, 'arduino', 'upload-profiles.json');
    }

    getPreferredFqbn (peripheral) {
        const peripheralKey = createPeripheralKey(peripheral);
        if (!peripheralKey) return null;
        const profile = this._read().profiles[peripheralKey];
        return profile && typeof profile.fqbn === 'string' ? profile.fqbn : null;
    }

    savePreferredFqbn (peripheral, fqbn) {
        const peripheralKey = createPeripheralKey(peripheral);
        if (!peripheralKey || typeof fqbn !== 'string' || !fqbn) return false;

        const data = this._read();
        data.profiles[peripheralKey] = {
            fqbn,
            updatedAt: new Date().toISOString()
        };
        data.profiles = Object.fromEntries(
            Object.entries(data.profiles)
                .sort((left, right) => String(right[1].updatedAt).localeCompare(String(left[1].updatedAt)))
                .slice(0, MAX_SAVED_PROFILES)
        );
        return this._write(data);
    }

    _emptyData () {
        return {
            schemaVersion: PROFILE_SCHEMA_VERSION,
            profiles: {}
        };
    }

    _read () {
        try {
            const data = JSON.parse(fs.readFileSync(this._filePath, 'utf8'));
            if (data.schemaVersion !== PROFILE_SCHEMA_VERSION ||
                !data.profiles || typeof data.profiles !== 'object' || Array.isArray(data.profiles)) {
                return this._emptyData();
            }
            return data;
        } catch (err) {
            return this._emptyData();
        }
    }

    _write (data) {
        const directory = path.dirname(this._filePath);
        const temporaryPath = `${this._filePath}.${process.pid}.${Date.now()}.partial`;
        try {
            fs.mkdirSync(directory, {recursive: true});
            fs.writeFileSync(temporaryPath, `${JSON.stringify(data, null, 2)}\n`, {mode: 0o600});
            try {
                fs.renameSync(temporaryPath, this._filePath);
            } catch (err) {
                if (!['EACCES', 'EEXIST', 'EPERM'].includes(err.code)) throw err;
                fs.rmSync(this._filePath, {force: true});
                fs.renameSync(temporaryPath, this._filePath);
            }
            return true;
        } catch (err) {
            fs.rmSync(temporaryPath, {force: true});
            return false;
        }
    }
}

module.exports = ArduinoUploadProfileStore;
module.exports.createPeripheralKey = createPeripheralKey;
