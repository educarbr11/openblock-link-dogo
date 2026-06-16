const fs = require('fs');
const os = require('os');
const path = require('path');
const fetch = require('node-fetch');
const AdmZip = require('adm-zip');
const ansi = require('ansi-string');

const SCRATCH_MICROBIT_HEX_ZIP =
    'https://downloads.scratch.mit.edu/microbit/scratch-microbit.hex.zip';
const DOGOBLOCK_MICROBIT_HEX_NAMES = {
    v1: 'dogoblock-microbit-ble.hex',
    v2: 'dogoblock-microbit-ble-v2.hex'
};

class MicrobitBleFirmware {
    constructor (userDataPath, sendstd) {
        this._cachePath = path.join(userDataPath, 'microbit-ble');
        this._zipPath = path.join(this._cachePath, 'scratch-microbit.hex.zip');
        this._hexPath = path.join(this._cachePath, 'scratch-microbit.hex');
        this._sendstd = sendstd;
    }

    async flashScratchBleFirmware () {
        fs.mkdirSync(this._cachePath, {recursive: true});
        const volume = this._findMicrobitVolume();
        if (!volume) {
            throw new Error('MICROBIT volume not found. Connect the micro:bit by USB and try again.');
        }

        const firmware = await this._ensureHex(volume);
        this._sendstd(`${ansi.clear}Writing ${firmware.name} to ${volume}\n`);
        fs.copyFileSync(firmware.path, path.join(volume, firmware.name));
        this._sendstd(`${ansi.clear}Firmware copied. Wait for the micro:bit to restart ` +
            `before connecting by Bluetooth.\n`);
        return 'Success';
    }

    async _ensureHex (volume) {
        const microbitVersion = this._detectMicrobitVersion(volume);
        const dogoblockHexPath = this._findDogoblockHex(microbitVersion);
        if (dogoblockHexPath) {
            const firmwareName = DOGOBLOCK_MICROBIT_HEX_NAMES[microbitVersion];
            return {
                name: firmwareName,
                path: dogoblockHexPath
            };
        }

        this._sendstd(`${ansi.clear}Dogoblock micro:bit BLE firmware for ${microbitVersion} not found. ` +
            `Falling back to Scratch firmware; digital pin write blocks require Dogoblock firmware.\n`);
        if (!fs.existsSync(this._hexPath)) {
            await this._downloadZip();
            this._extractHex();
        }
        return {
            name: 'scratch-microbit.hex',
            path: this._hexPath
        };
    }

    _findDogoblockHex (microbitVersion) {
        const firmwareName = DOGOBLOCK_MICROBIT_HEX_NAMES[microbitVersion] ||
            DOGOBLOCK_MICROBIT_HEX_NAMES.v1;
        const versionEnvVar = microbitVersion === 'v2' ?
            process.env.DOGOBLOCK_MICROBIT_BLE_HEX_V2 :
            process.env.DOGOBLOCK_MICROBIT_BLE_HEX_V1;
        const candidates = this._dedupe([
            versionEnvVar,
            process.env.DOGOBLOCK_MICROBIT_BLE_HEX,
            process.resourcesPath && path.join(
                process.resourcesPath,
                'firmwares',
                'microbit',
                firmwareName
            ),
            path.resolve(__dirname, '..', '..', 'firmwares', 'microbit', firmwareName)
        ].filter(Boolean));

        return candidates.find(candidate => fs.existsSync(candidate));
    }

    _detectMicrobitVersion (volume) {
        const detailsPath = path.join(volume, 'DETAILS.TXT');
        if (!fs.existsSync(detailsPath)) {
            return 'v1';
        }

        try {
            const details = fs.readFileSync(detailsPath, 'utf8');
            if (/micro:bit\s*v2/i.test(details) ||
                /\bboard\s*id\s*:\s*9904\b/i.test(details) ||
                /\bboard-id\s*:\s*9904\b/i.test(details) ||
                /\b9904\b/.test(details)) {
                return 'v2';
            }
        } catch (err) {
            // Keep firmware upload working if DETAILS.TXT is unreadable.
        }

        return 'v1';
    }

    async _downloadZip () {
        this._sendstd(`${ansi.clear}Downloading Scratch micro:bit Bluetooth firmware...\n`);
        const response = await fetch(SCRATCH_MICROBIT_HEX_ZIP);
        if (!response.ok) {
            throw new Error(`Could not download Scratch micro:bit firmware: ${response.status}`);
        }
        const buffer = await response.buffer();
        fs.writeFileSync(this._zipPath, buffer);
    }

    _extractHex () {
        this._sendstd(`${ansi.clear}Extracting firmware...\n`);
        const zip = new AdmZip(this._zipPath);
        const entry = zip.getEntries().find(item => item.entryName.toLowerCase().endsWith('.hex'));
        if (!entry) {
            throw new Error('Downloaded Scratch micro:bit firmware did not contain a HEX file.');
        }
        fs.writeFileSync(this._hexPath, entry.getData());
    }

    _findMicrobitVolume () {
        const candidates = this._candidateVolumes();
        return candidates.find(candidate => this._isMicrobitVolume(candidate));
    }

    _candidateVolumes () {
        const user = os.userInfo().username;
        const candidates = this._dedupe([
            '/Volumes/MICROBIT',
            path.join('/media', user, 'MICROBIT'),
            path.join('/run/media', user, 'MICROBIT'),
            '/mnt/MICROBIT',
            ...this._mountedLinuxVolumes('/media'),
            ...this._mountedLinuxVolumes('/run/media')
        ]);

        if (process.platform === 'win32') {
            for (let code = 65; code <= 90; code++) {
                candidates.push(`${String.fromCharCode(code)}:\\`);
            }
        }

        return candidates;
    }

    _mountedLinuxVolumes (basePath) {
        if (!fs.existsSync(basePath)) {
            return [];
        }
        return fs.readdirSync(basePath)
            .reduce((result, entry) => {
                const userPath = path.join(basePath, entry);
                try {
                    const stat = fs.statSync(userPath);
                    if (stat.isDirectory()) {
                        result.push(path.join(userPath, 'MICROBIT'));
                    }
                } catch (err) {
                    // Ignore mount points that disappear while scanning.
                }
                return result;
            }, []);
    }

    _dedupe (items) {
        return items.filter((item, index) => items.indexOf(item) === index);
    }

    _isMicrobitVolume (candidate) {
        if (!candidate || !fs.existsSync(candidate)) {
            return false;
        }
        return fs.existsSync(path.join(candidate, 'DETAILS.TXT')) ||
            fs.existsSync(path.join(candidate, 'MICROBIT.HTM'));
    }
}

module.exports = MicrobitBleFirmware;
