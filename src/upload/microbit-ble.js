const fs = require('fs');
const os = require('os');
const path = require('path');
const fetch = require('node-fetch');
const AdmZip = require('adm-zip');
const ansi = require('ansi-string');

const SCRATCH_MICROBIT_HEX_ZIP =
    'https://downloads.scratch.mit.edu/microbit/scratch-microbit.hex.zip';

class MicrobitBleFirmware {
    constructor (userDataPath, sendstd) {
        this._cachePath = path.join(userDataPath, 'microbit-ble');
        this._zipPath = path.join(this._cachePath, 'scratch-microbit.hex.zip');
        this._hexPath = path.join(this._cachePath, 'scratch-microbit.hex');
        this._sendstd = sendstd;
    }

    async flashScratchBleFirmware () {
        fs.mkdirSync(this._cachePath, {recursive: true});
        await this._ensureHex();
        const volume = this._findMicrobitVolume();
        if (!volume) {
            throw new Error('MICROBIT volume not found. Connect the micro:bit by USB and try again.');
        }

        this._sendstd(`${ansi.clear}Writing Scratch micro:bit Bluetooth firmware to ${volume}\n`);
        fs.copyFileSync(this._hexPath, path.join(volume, 'scratch-microbit.hex'));
        this._sendstd(`${ansi.clear}Firmware copied. Wait for the micro:bit to restart ` +
            `before connecting by Bluetooth.\n`);
        return 'Success';
    }

    async _ensureHex () {
        if (!fs.existsSync(this._hexPath)) {
            await this._downloadZip();
            this._extractHex();
        }
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
