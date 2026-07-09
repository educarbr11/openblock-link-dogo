const {SerialPort} = require('serialport');
const ansi = require('ansi-string');
const fs = require('fs');
const os = require('os');
const path = require('path');

const Session = require('./session');
const Arduino = require('../upload/arduino');
const Microbit = require('../upload/microbit');
const usbId = require('../lib/usb-id');

const PERIPHERAL_UNPLUG_CHECK_INTERVAL = 100;
const MICROBIT_REALTIME_FIRMWARE_V2 = 'dogoblock-microbit-realtime-v2.hex';
const MICROBIT_HEX_WRITE_CHUNK_SIZE = 4096;
const MICROBIT_HEX_WRITE_RETRIES = 2;
const MICROBIT_HEX_WRITE_RETRY_DELAY_MS = 1200;
const MICROBIT_HEX_WRITE_CHUNK_DELAY_MS = 8;
const MICROBIT_TRANSFER_VERIFY_DELAY_MS = 6000;

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

const isUnsupportedControlSignalError = err => {
    if (!err) return false;
    const message = String(err.message || err);
    return message.includes('Operation not supported') ||
        message.includes('cannot set') ||
        message.includes('Inappropriate ioctl');
};

class SerialportSession extends Session {
    constructor (socket, userDataPath, toolsPath) {
        super(socket);

        this.userDataPath = userDataPath;
        this.toolsPath = toolsPath;

        this._type = 'serialport';
        this.peripheral = null;
        this.peripheralParams = null;
        this.services = null;
        this.reportedPeripherals = {};
        this.connectStateDetectorTimer = null;
        this.peripheralsScanorTimer = null;
        this.isRead = false;
        this.isInDisconnect = false;
        this.tool = null;
    }

    async didReceiveCall (method, params, completion) {
        switch (method) {
        case 'discover':
            this.discover(params);
            completion(null, null);
            break;
        case 'connect':
            await this.connect(params);
            completion(null, null);
            break;
        case 'disconnect':
            await this.disconnect();
            completion(null, null);
            break;
        case 'updateBaudrate':
            completion(await this.updateBaudrate(params), null);
            break;
        case 'write':
            completion(await this.write(params), null);
            break;
        case 'read':
            await this.read(params);
            completion(null, null);
            break;
        case 'upload':
            completion(await this.upload(params), null);
            break;
        case 'uploadFirmware':
            completion(await this.uploadFirmware(params), null);
            break;
        case 'abortUpload':
            completion(await this.abortUpload(), null);
            break;
        case 'getServices':
            completion((this.services || []).map(service => service.uuid), null);
            break;
        case 'pingMe':
            completion('willPing', null);
            this.sendRemoteRequest('ping', null, result => {
                console.log(`Got result from ping: ${result}`);
            });
            break;
        default:
            throw new Error(`Method not found`);
        }
    }

    discover (params) {
        if (this.services) {
            throw new Error('cannot discover when connected');
        }
        const {filters} = params;
        if (!Array.isArray(filters.pnpid) || filters.pnpid.length < 1) {
            throw new Error('discovery request must include filters');
        }
        this.reportedPeripherals = {};

        this.peripheralsScanorTimer = setInterval(() => {
            SerialPort.list().then(peripheral => {
                this.onAdvertisementReceived(peripheral, filters);
            });
        }, 100);
    }

    onAdvertisementReceived (peripheral, filters) {
        if (peripheral) {
            peripheral.forEach(device => {
                const vendorId = String(device.vendorId).toUpperCase();
                const productId = String(device.productId).toUpperCase();
                const pnpid = `USB\\VID_${vendorId}&PID_${productId}`;

                const name = usbId[pnpid] ? usbId[pnpid] : 'Unknown device';

                if (filters.pnpid.includes('*')) {
                    this.reportedPeripherals[device.path] = device;
                    this.sendRemoteRequest('didDiscoverPeripheral', {
                        peripheralId: device.path,
                        name: `${name} (${device.path})`
                    });
                } else if (filters.pnpid.includes(pnpid)) {
                    this.reportedPeripherals[device.path] = device;
                    this.sendRemoteRequest('didDiscoverPeripheral', {
                        peripheralId: device.path,
                        name: `${name} (${device.path})`
                    });
                }
            });
        }
    }

    connect (params, isConnectAfterUpload = false) {
        return new Promise((resolve, reject) => {
            if (this.peripheral && this.peripheral.isOpen === true) {
                return reject(new Error('already connected to peripheral'));
            }
            const {peripheralId, peripheralConfig} = params;

            const peripheral = this.reportedPeripherals[peripheralId];
            if (!peripheral) {
                return reject(new Error(`invalid peripheral ID: ${peripheralId}`));
            }
            if (this.peripheralsScanorTimer) {
                clearInterval(this.peripheralsScanorTimer);
                this.peripheralsScanorTimer = null;
            }
            const port = new SerialPort({
                path: peripheral.path,
                baudRate: peripheralConfig.config.baudRate,
                dataBits: peripheralConfig.config.dataBits,
                stopBits: peripheralConfig.config.stopBits,
                autoOpen: false
            });
            const rts = (typeof peripheralConfig.config.rts === 'undefined') ? true : peripheralConfig.config.rts;
            const dtr = (typeof peripheralConfig.config.dtr === 'undefined') ? true : peripheralConfig.config.dtr;

            try {
                port.open(openErr => {
                    if (openErr) {
                        if (isConnectAfterUpload === true) {
                            this.sendRemoteRequest('uploadError', {
                                message: ansi.red + openErr.message
                            });
                            this.sendRemoteRequest('peripheralUnplug', null);
                        }
                        if (openErr.message.includes('Access denied')) {
                            this.sendRemoteRequest('connectError', {message: 'Access denied'});
                        }
                        if (openErr.message.includes('Open (SetCommState): Unknown error code 31')) {
                            this.sendRemoteRequest('connectError', {message: 'Unknown error code 31'});
                        }
                        return reject(new Error(openErr));
                    }

                    const finishConnection = () => {
                        this.peripheral = port;
                        this.peripheralParams = params;

                        // Scan COM status prevent device pulled out
                        this.connectStateDetectorTimer = setInterval(() => {
                            if (this.peripheral.isOpen === false) {
                                clearInterval(this.connectStateDetectorTimer);
                                this.disconnect();
                                this.sendRemoteRequest('peripheralUnplug', null);
                            }
                        }, PERIPHERAL_UNPLUG_CHECK_INTERVAL);

                        // Only when the receiver function is set, can isopen detect that the device is pulled out
                        // A strange features of npm serialport package
                        port.on('data', rev => {
                            this.onMessageCallback(rev);
                        });

                        port.on('error', error => {
                            console.log('OpenBlock Link Error:', error);
                            this.disconnect();
                            this.sendRemoteRequest('peripheralUnplug', null);
                        });

                        resolve();
                    };

                    port.set({rts: rts, dtr: dtr}, setErr => {
                        if (setErr) {
                            if (isUnsupportedControlSignalError(setErr)) {
                                console.warn(
                                    'OpenBlock Link Warning: serial control signals are not supported on ' +
                                    `${peripheral.path}: ${setErr.message || setErr}`
                                );
                                return finishConnection();
                            }
                            if (isConnectAfterUpload === true) {
                                this.sendRemoteRequest('peripheralUnplug', null);
                            }
                            port.close(() => reject(new Error(setErr)));
                            return;
                        }

                        finishConnection();
                    });
                });
            } catch (err) {
                reject(err);
            }
        });
    }

    onMessageCallback (rev) {
        const params = {
            encoding: 'base64',
            message: rev.toString('base64')
        };
        if (this.isRead) {
            this.sendRemoteRequest('onMessage', params);
        }
    }

    updateBaudrate (params) {
        return new Promise((resolve, reject) => {
            if (this.isInDisconnect) {
                return resolve();
            }
            this.peripheralParams.peripheralConfig.config.baudRate = params.baudRate;
            this.peripheral.update(params, err => {
                if (err) {
                    return reject(new Error(`Error while attempting to update baudrate: ${err.message}`));
                }

                const rts = (typeof this.peripheralParams.peripheralConfig.config.rts === 'undefined') ?
                    true : this.peripheralParams.peripheralConfig.config.rts;
                const dtr = (typeof this.peripheralParams.peripheralConfig.config.dtr === 'undefined') ?
                    true : this.peripheralParams.peripheralConfig.config.dtr;

                // After update baudrate, the rts and dtr will be automatically modified,
                // we have to set them again.
                this.peripheral.set({rts: rts, dtr: dtr}, setErr => {
                    if (setErr) {
                        if (isUnsupportedControlSignalError(setErr)) {
                            console.warn(
                                'OpenBlock Link Warning: serial control signals are not supported after ' +
                                `baudrate update: ${setErr.message || setErr}`
                            );
                            return resolve();
                        }
                        this.sendRemoteRequest('peripheralUnplug', null);
                        return reject(new Error(setErr));
                    }
                    return resolve();
                });
            });

        });
    }

    write (params) {
        return new Promise((resolve, reject) => {
            const {message, encoding} = params;
            const buffer = new Buffer.from(message, encoding);

            try {
                if (!this.isInDisconnect) {
                    this.peripheral.write(buffer, 'binary', err => {
                        if (err) {
                            return reject(new Error(`Error while attempting to write: ${err.message}`));
                        }
                    });
                    this.peripheral.drain(() => resolve(buffer.length));
                }
                return resolve();
            } catch (err) {
                return reject(err);
            }
        });
    }

    read () {
        this.isRead = true;
    }

    disconnect () {
        this.isInDisconnect = true;
        return new Promise((resolve, reject) => {
            if (this.peripheral && this.peripheral.isOpen === true) {
                if (this.connectStateDetectorTimer) {
                    clearInterval(this.connectStateDetectorTimer);
                    this.connectStateDetectorTimer = null;
                }
                const peripheral = this.peripheral;
                try {
                    peripheral.pause();
                    // clear all cache data
                    peripheral.flush(() => {
                        peripheral.close(error => {
                            if (error) {
                                this.isInDisconnect = false;
                                return reject(Error(error));
                            }
                            this.isInDisconnect = false;
                            return resolve();
                        });
                    });
                } catch (err) {
                    this.isInDisconnect = false;
                    return reject(err);
                }
            } else {
                return resolve();
            }
        });
    }

    async upload (params) {
        const {message, config, encoding, uploadOptions} = params;
        const code = new Buffer.from(message, encoding).toString();

        if (uploadOptions && uploadOptions.artifactType === 'microbitHex') {
            try {
                this.sendRemoteRequest('setUploadAbortEnabled', false);
                const volume = this._findMicrobitVolume();
                if (!volume) {
                    throw new Error('Unidade MICROBIT nao encontrada. Conecte o micro:bit por USB e tente novamente.');
                }
                const fileName = uploadOptions.fileName || 'main.hex';
                const safeFileName = path.basename(fileName).replace(/[^a-z0-9_.-]/gi, '_') ||
                    'main.hex';
                const targetPath = path.join(volume, safeFileName);
                this.sendstd(`${ansi.clear}Copiando programa MicroPython para ${volume}\n`);
                this._clearMicrobitFailFile(volume);
                await this._writeHexToMicrobitVolume(code, targetPath);
                await this._verifyMicrobitTransfer(volume);
                this.sendstd(
                    `${ansi.clear}Programa copiado. Aguarde o micro:bit reiniciar. ` +
                    'Isso pode levar alguns segundos antes do codigo comecar a executar.\n'
                );
                this.sendRemoteRequest('uploadSuccess', {aborted: false});
            } catch (err) {
                this.sendRemoteRequest('uploadError', {
                    message: ansi.red + err.message
                });
            }
            return;
        }

        if (!this.peripheralParams || !this.peripheral) {
            this.sendRemoteRequest('uploadError', {
                message: `${ansi.red}Nenhuma placa conectada para envio serial.`
            });
            return;
        }

        const {baudRate} = this.peripheralParams.peripheralConfig.config;

        switch (config.type) {
        case 'arduino':
            this.tool = new Arduino(this.peripheral.path, config, this.userDataPath,
                this.toolsPath, this.sendstd.bind(this), this.sendRemoteRequest.bind(this));

            try {
                this.sendRemoteRequest('setUploadAbortEnabled', true);
                if (uploadOptions && uploadOptions.artifactType === 'compiledArtifact') {
                    const artifactDir = path.join(this.userDataPath, 'arduino', 'artifacts');
                    fs.mkdirSync(artifactDir, {recursive: true});
                    const artifactPath = path.join(
                        artifactDir,
                        `${Date.now()}-${config.fqbn.replace(/[^a-z0-9]/gi, '_')}.hex`
                    );
                    fs.writeFileSync(artifactPath, code);

                    try {
                        this.sendstd(`${ansi.clear}Disconnect serial port\n`);
                        await this.disconnect();
                        this.sendstd(`${ansi.clear}Disconnected successfully, flash program starting...\n`);
                        const flashExitCode = await this.tool.flashArtifact(artifactPath);
                        await this.connect(this.peripheralParams, true);
                        this.sendRemoteRequest('uploadSuccess', {aborted: flashExitCode === 'Aborted'});
                    } finally {
                        fs.rmSync(artifactPath, {force: true});
                    }
                    break;
                }

                const exitCode = await this.tool.build(code);
                if (exitCode === 'Success') {
                    try {
                        this.sendstd(`${ansi.clear}Disconnect serial port\n`);
                        await this.disconnect();
                        this.sendstd(`${ansi.clear}Disconnected successfully, flash program starting...\n`);
                        const flashExitCode = await this.tool.flash();
                        await this.connect(this.peripheralParams, true);
                        this.sendRemoteRequest('uploadSuccess', {aborted: flashExitCode === 'Aborted'});
                    } catch (err) {
                        this.sendRemoteRequest('uploadError', {
                            message: ansi.red + err.message
                        });
                        // if error in flash step. It is considered that the device has been removed.
                        this.sendRemoteRequest('peripheralUnplug', null);
                    }
                } else if (exitCode === 'Aborted') {
                    this.sendRemoteRequest('uploadSuccess', {aborted: true});
                }
            } catch (err) {
                this.sendRemoteRequest('uploadError', {
                    message: ansi.red + err.message
                });
            }
            break;
        case 'microbit':
            this.tool = new Microbit(this.peripheral.path, config, this.userDataPath,
                this.toolsPath, this.sendstd.bind(this), this.sendRemoteRequest.bind(this));
            try {
                this.sendRemoteRequest('setUploadAbortEnabled', true);
                await this.disconnect();
                const exitCode = await this.tool.flash(code);
                await this.connect(this.peripheralParams, true);
                await this.updateBaudrate({baudRate: 115200});
                this.sendstd(`${ansi.clear}Reset device\n`);
                await this.write({message: '04', encoding: 'hex'});
                await this.updateBaudrate({baudRate: baudRate});

                this.sendRemoteRequest('uploadSuccess', {aborted: exitCode === 'Aborted'});
            } catch (err) {
                this.sendRemoteRequest('uploadError', {
                    message: ansi.red + err.message
                });
                this.sendRemoteRequest('peripheralUnplug', null);
            }
            break;
        }

        this.tool = null;
    }

    _findMicrobitVolume () {
        const candidates = this._candidateMicrobitVolumes();
        return candidates.find(candidate => this._isMicrobitVolume(candidate));
    }

    _candidateMicrobitVolumes () {
        const user = os.userInfo().username;
        const candidates = [
            '/Volumes/MICROBIT',
            path.join('/media', user, 'MICROBIT'),
            path.join('/run/media', user, 'MICROBIT'),
            '/mnt/MICROBIT',
            ...this._mountedLinuxMicrobitVolumes('/media'),
            ...this._mountedLinuxMicrobitVolumes('/run/media')
        ];

        if (process.platform === 'win32') {
            for (let code = 65; code <= 90; code++) {
                candidates.push(`${String.fromCharCode(code)}:\\`);
            }
        }

        return candidates.filter((item, index) => item && candidates.indexOf(item) === index);
    }

    _mountedLinuxMicrobitVolumes (basePath) {
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

    _isMicrobitVolume (candidate) {
        if (!candidate || !fs.existsSync(candidate)) {
            return false;
        }
        return fs.existsSync(path.join(candidate, 'DETAILS.TXT')) ||
            fs.existsSync(path.join(candidate, 'MICROBIT.HTM'));
    }

    async _copyHexToMicrobitVolume (sourcePath, targetPath) {
        const data = fs.readFileSync(sourcePath);
        await this._writeHexToMicrobitVolume(data, targetPath);
    }

    async _writeHexToMicrobitVolume (hexData, targetPath) {
        const data = Buffer.isBuffer(hexData) ? hexData : Buffer.from(hexData);
        let lastError = null;

        for (let attempt = 0; attempt <= MICROBIT_HEX_WRITE_RETRIES; attempt++) {
            try {
                await this._writeHexToMicrobitVolumeOnce(data, targetPath);
                return;
            } catch (err) {
                lastError = err;
                try {
                    fs.rmSync(targetPath, {force: true});
                } catch (removeErr) {
                    // Ignore partial files that DAPLink already consumed.
                }
                if (attempt < MICROBIT_HEX_WRITE_RETRIES) {
                    this.sendstd(
                        `${ansi.yellow_dark}Falha temporaria ao copiar para o micro:bit. ` +
                        'Tentando novamente...\n'
                    );
                    await wait(MICROBIT_HEX_WRITE_RETRY_DELAY_MS);
                }
            }
        }

        throw lastError;
    }

    async _writeHexToMicrobitVolumeOnce (data, targetPath) {
        const fd = fs.openSync(targetPath, 'w');
        try {
            for (let offset = 0; offset < data.length; offset += MICROBIT_HEX_WRITE_CHUNK_SIZE) {
                const chunk = data.slice(offset, Math.min(offset + MICROBIT_HEX_WRITE_CHUNK_SIZE, data.length));
                fs.writeSync(fd, chunk, 0, chunk.length);
                if (offset % (MICROBIT_HEX_WRITE_CHUNK_SIZE * 16) === 0) {
                    fs.fsyncSync(fd);
                }
                await wait(MICROBIT_HEX_WRITE_CHUNK_DELAY_MS);
            }
            fs.fsyncSync(fd);
        } finally {
            fs.closeSync(fd);
        }
    }

    _clearMicrobitFailFile (volume) {
        try {
            fs.rmSync(path.join(volume, 'FAIL.TXT'), {force: true});
        } catch (err) {
            // Ignore stale DAPLink status files that cannot be removed.
        }
    }

    async _verifyMicrobitTransfer (volume) {
        await wait(MICROBIT_TRANSFER_VERIFY_DELAY_MS);
        const failPath = path.join(volume, 'FAIL.TXT');
        if (fs.existsSync(failPath)) {
            const message = fs.readFileSync(failPath, 'utf8').trim();
            throw new Error(message || 'Falha ao transferir arquivo para o micro:bit.');
        }
    }

    async uploadFirmware (params) {
        switch (params.type) {
        case 'arduino':
            this.tool = new Arduino(this.peripheral.path, params, this.userDataPath,
                this.toolsPath, this.sendstd.bind(this));
            try {
                this.sendRemoteRequest('setUploadAbortEnabled', true);
                this.sendstd(`${ansi.clear}Disconnect serial port\n`);
                await this.disconnect();
                this.sendstd(`${ansi.clear}Disconnected successfully, flash program starting...\n`);
                const flashExitCode = await this.tool.flashRealtimeFirmware();
                await this.connect(this.peripheralParams, true);
                this.sendRemoteRequest('uploadSuccess', {aborted: flashExitCode === 'Aborted'});
            } catch (err) {
                this.sendRemoteRequest('uploadError', {
                    message: ansi.red + err.message
                });
            }
            break;
        case 'microbit': {
            try {
                this.sendRemoteRequest('setUploadAbortEnabled', false);
                const volume = this._findMicrobitVolume();
                if (!volume) {
                    throw new Error('Unidade MICROBIT nao encontrada. Conecte o micro:bit por USB e tente novamente.');
                }
                const firmwarePath = this._findMicrobitRealtimeFirmware();
                if (!firmwarePath) {
                    throw new Error('Firmware dogoblock-microbit-realtime-v2.hex nao encontrado no DoGoBlock Link.');
                }
                const targetPath = path.join(volume, MICROBIT_REALTIME_FIRMWARE_V2);
                this.sendstd(`${ansi.clear}Copiando firmware do modo palco para ${volume}\n`);
                this._clearMicrobitFailFile(volume);
                await this._copyHexToMicrobitVolume(firmwarePath, targetPath);
                await this._verifyMicrobitTransfer(volume);
                this.sendstd(`${ansi.clear}Firmware do modo palco copiado. Aguarde o micro:bit reiniciar.\n`);
                this.sendRemoteRequest('uploadSuccess', {aborted: false});
            } catch (err) {
                this.sendRemoteRequest('uploadError', {
                    message: ansi.red + err.message
                });
            }
            break;
        }
        }

        this.tool = null;
    }

    _findMicrobitRealtimeFirmware () {
        const candidates = [
            process.env.DOGOBLOCK_MICROBIT_REALTIME_HEX_V2,
            process.env.DOGOBLOCK_MICROBIT_REALTIME_HEX,
            process.resourcesPath && path.join(
                process.resourcesPath,
                'firmwares',
                'microbit',
                MICROBIT_REALTIME_FIRMWARE_V2
            ),
            path.join(process.cwd(), 'firmwares', 'microbit', MICROBIT_REALTIME_FIRMWARE_V2),
            path.resolve(__dirname, '..', '..', 'firmwares', 'microbit', MICROBIT_REALTIME_FIRMWARE_V2),
            path.resolve(__dirname, '..', '..', '..', '..', 'firmwares', 'microbit', MICROBIT_REALTIME_FIRMWARE_V2)
        ].filter(Boolean);

        return candidates.find(candidate => fs.existsSync(candidate));
    }

    async abortUpload () {
        if (this.tool !== null) {
            this.tool.abortUpload();
        }
    }

    sendstd (message) {
        if (this._socket) {
            this.sendRemoteRequest('uploadStdout', {
                message: message
            });
        }
    }

    dispose () {
        this.disconnect();
        super.dispose();
        this.socket = null;
        this.peripheral = null;
        this.peripheralParams = null;
        this.services = null;
        this.reportedPeripherals = {};
        if (this.connectStateDetectorTimer) {
            clearInterval(this.connectStateDetectorTimer);
            this.connectStateDetectorTimer = null;
        }
        if (this.peripheralsScanorTimer) {
            clearInterval(this.peripheralsScanorTimer);
            this.peripheralsScanorTimer = null;
        }
    }
}

module.exports = SerialportSession;
