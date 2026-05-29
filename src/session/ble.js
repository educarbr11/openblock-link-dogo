const Session = require('./session');
const MicrobitBleFirmware = require('../upload/microbit-ble');

let noble = null;
let dbus = null;

const normalizeUuid = uuid => String(uuid)
    .toLowerCase()
    .replace(/-/g, '');
const serviceUuid = id => normalizeUuid(Number(id).toString(16));
const MICROBIT_NAME_RE = /micro:bit|microbit/i;
const BLUEZ_SERVICE = 'org.bluez';
const BLUEZ_ADAPTER_IFACE = 'org.bluez.Adapter1';
const BLUEZ_DEVICE_IFACE = 'org.bluez.Device1';
const BLUEZ_CHARACTERISTIC_IFACE = 'org.bluez.GattCharacteristic1';
const DBUS_OBJECT_MANAGER_IFACE = 'org.freedesktop.DBus.ObjectManager';
const DBUS_PROPERTIES_IFACE = 'org.freedesktop.DBus.Properties';

class BLESession extends Session {
    constructor (socket, userDataPath) {
        super(socket);

        this.userDataPath = userDataPath;
        this._type = 'ble';
        this.reportedPeripherals = {};
        this.peripheral = null;
        this.characteristics = {};
        this._discoverHandler = this._onDiscover.bind(this);
        this.tool = null;
        this._scanServices = [];
        this._listAll = false;

        this._useBlueZ = process.platform === 'linux';
        this._bluezBus = null;
        this._bluezObjects = null;
        this._bluezObjectManager = null;
        this._bluezInterfacesAddedHandler = null;
        this._bluezAdapterPath = null;
        this._bluezDiscoverInterval = null;
    }

    async didReceiveCall (method, params, completion) {
        try {
            switch (method) {
            case 'discover':
                await this.discover(params);
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
            case 'read':
                completion(await this.read(params), null);
                break;
            case 'startNotifications':
                completion(await this.startNotifications(params), null);
                break;
            case 'write':
                completion(await this.write(params), null);
                break;
            case 'uploadFirmware':
                completion(await this.uploadFirmware(params), null);
                break;
            case 'abortUpload':
                completion(null, null);
                break;
            default:
                throw new Error('Method not found');
            }
        } catch (error) {
            completion(null, error.message);
        }
    }

    async discover (params) {
        if (this._useBlueZ) {
            return this._bluezDiscover(params);
        }

        const nobleInstance = this._getNoble();
        this.reportedPeripherals = {};
        this._listAll = Boolean(params.listAll);
        nobleInstance.removeListener('discover', this._discoverHandler);
        nobleInstance.on('discover', this._discoverHandler);

        const filters = params.filters || [];
        this._scanServices = filters.reduce((result, filter) => {
            if (filter.services) {
                filter.services.forEach(service => result.push(serviceUuid(service)));
            }
            return result;
        }, []);

        await this._waitForPoweredOn(nobleInstance);
        nobleInstance.startScanning([], false, err => {
            if (err) {
                this.sendRemoteRequest('userDidNotPickPeripheral', null);
            }
        });
    }

    connect (params) {
        if (this._useBlueZ) {
            return this._bluezConnect(params);
        }

        return new Promise((resolve, reject) => {
            const peripheral = this.reportedPeripherals[params.peripheralId];
            if (!peripheral) {
                return reject(new Error(`invalid peripheral ID: ${params.peripheralId}`));
            }

            this._getNoble().stopScanning();
            peripheral.connect(error => {
                if (error) {
                    return reject(error);
                }
                this.peripheral = peripheral;
                peripheral.once('disconnect', () => {
                    this.sendRemoteRequest('peripheralUnplug', null);
                });
                peripheral.discoverAllServicesAndCharacteristics((discoverError, services, characteristics) => {
                    if (discoverError) {
                        return reject(discoverError);
                    }
                    this.characteristics = {};
                    characteristics.forEach(characteristic => {
                        this.characteristics[normalizeUuid(characteristic.uuid)] = characteristic;
                    });
                    return resolve();
                });
            });
        });
    }

    read (params) {
        if (this._useBlueZ) {
            return this._bluezRead(params);
        }

        return new Promise((resolve, reject) => {
            const characteristic = this._getCharacteristic(params.characteristicId);
            characteristic.read((error, data) => {
                if (error) {
                    if (params.startNotifications) {
                        return this.startNotifications(params)
                            .then(() => resolve())
                            .catch(reject);
                    }
                    return reject(error);
                }
                const message = data.toString('base64');
                if (params.startNotifications) {
                    this.startNotifications(params)
                        .then(() => resolve({encoding: 'base64', message}))
                        .catch(reject);
                } else {
                    resolve({encoding: 'base64', message});
                }
            });
        });
    }

    startNotifications (params) {
        if (this._useBlueZ) {
            return this._bluezStartNotifications(params);
        }

        return new Promise((resolve, reject) => {
            const characteristic = this._getCharacteristic(params.characteristicId);
            characteristic.removeAllListeners('data');
            characteristic.on('data', data => {
                this.sendRemoteRequest('characteristicDidChange', {
                    encoding: 'base64',
                    message: data.toString('base64')
                });
            });
            characteristic.subscribe(error => {
                if (error) {
                    return reject(error);
                }
                return resolve();
            });
        });
    }

    write (params) {
        if (this._useBlueZ) {
            return this._bluezWrite(params);
        }

        return new Promise((resolve, reject) => {
            const characteristic = this._getCharacteristic(params.characteristicId);
            const buffer = params.encoding ? Buffer.from(params.message, params.encoding) : Buffer.from(params.message);
            characteristic.write(buffer, params.withResponse !== true, error => {
                if (error) {
                    return reject(error);
                }
                return resolve(buffer.length);
            });
        });
    }

    async uploadFirmware (params) {
        switch (params.type) {
        case 'microbitBle':
            this.tool = new MicrobitBleFirmware(this.userDataPath, this.sendstd.bind(this));
            try {
                this.sendRemoteRequest('setUploadAbortEnabled', false);
                const exitCode = await this.tool.flashScratchBleFirmware();
                this.sendRemoteRequest('uploadSuccess', {aborted: exitCode === 'Aborted'});
            } catch (err) {
                this.sendRemoteRequest('uploadError', {message: err.message});
            }
            this.tool = null;
            break;
        default:
            throw new Error(`Unsupported BLE firmware type: ${params.type}`);
        }
    }

    disconnect () {
        if (this._useBlueZ) {
            return this._bluezDisconnect();
        }

        return new Promise(resolve => {
            if (noble) {
                noble.removeListener('discover', this._discoverHandler);
                noble.stopScanning();
            }
            if (this.peripheral && this.peripheral.state === 'connected') {
                this.peripheral.disconnect(() => resolve());
            } else {
                resolve();
            }
            this.peripheral = null;
            this.characteristics = {};
        });
    }

    sendstd (message) {
        if (this._socket) {
            this.sendRemoteRequest('uploadStdout', {message});
        }
    }

    dispose () {
        this.disconnect();
        super.dispose();
        this.reportedPeripherals = {};
        this.peripheral = null;
        this.characteristics = {};
    }

    _onDiscover (peripheral) {
        if (!this._matchesDiscoverFilter(peripheral)) {
            return;
        }
        const name = peripheral.advertisement && peripheral.advertisement.localName ?
            peripheral.advertisement.localName : peripheral.address || peripheral.id || 'Unknown BLE device';
        this.reportedPeripherals[peripheral.id] = peripheral;
        this.sendRemoteRequest('didDiscoverPeripheral', {
            peripheralId: peripheral.id,
            name,
            rssi: peripheral.rssi
        });
    }

    _matchesDiscoverFilter (peripheral) {
        if (this._listAll) {
            return true;
        }

        if (!this._scanServices.length) {
            return true;
        }

        const advertisement = peripheral.advertisement || {};
        const serviceUuids = (advertisement.serviceUuids || []).map(normalizeUuid);
        if (this._scanServices.some(service => serviceUuids.indexOf(service) > -1)) {
            return true;
        }

        const name = advertisement.localName || '';
        return MICROBIT_NAME_RE.test(name);
    }

    _getCharacteristic (characteristicId) {
        const characteristic = this.characteristics[normalizeUuid(characteristicId)];
        if (!characteristic) {
            throw new Error(`BLE characteristic not found: ${characteristicId}`);
        }
        return characteristic;
    }

    _getNoble () {
        if (!noble) {
            try {
                noble = require('@abandonware/noble'); // eslint-disable-line global-require
            } catch (error) {
                throw new Error(`Bluetooth support is not available: ${error.message}`);
            }
        }
        return noble;
    }

    _waitForPoweredOn (nobleInstance) {
        if (nobleInstance.state === 'poweredOn') {
            return Promise.resolve();
        }
        return new Promise((resolve, reject) => {
            let timeout = null;
            const onStateChange = state => {
                if (state === 'poweredOn') {
                    clearTimeout(timeout);
                    nobleInstance.removeListener('stateChange', onStateChange);
                    resolve();
                }
            };
            timeout = setTimeout(() => {
                nobleInstance.removeListener('stateChange', onStateChange);
                reject(new Error('Bluetooth adapter is not powered on'));
            }, 5000);
            nobleInstance.on('stateChange', onStateChange);
        });
    }

    async _bluezDiscover (params) {
        this.reportedPeripherals = {};
        this._listAll = Boolean(params.listAll);
        this._scanServices = (params.filters || []).reduce((result, filter) => {
            if (filter.services) {
                filter.services.forEach(service => result.push(serviceUuid(service)));
            }
            return result;
        }, []);

        await this._bluezInit();
        await this._bluezReportKnownDevices();

        const adapter = await this._bluezGetInterface(this._bluezAdapterPath, BLUEZ_ADAPTER_IFACE);
        try {
            await adapter.SetDiscoveryFilter({
                Transport: new dbus.Variant('s', 'le'),
                DuplicateData: new dbus.Variant('b', false)
            });
        } catch (err) {
            // Discovery can continue without this optional filter.
        }

        if (!this._bluezInterfacesAddedHandler) {
            this._bluezInterfacesAddedHandler = (objectPath, interfaces) => {
                if (interfaces[BLUEZ_DEVICE_IFACE]) {
                    this._bluezReportDevice(objectPath, interfaces[BLUEZ_DEVICE_IFACE]);
                }
            };
            this._bluezObjectManager.on('InterfacesAdded', this._bluezInterfacesAddedHandler);
        }

        await adapter.StartDiscovery();
        if (this._bluezDiscoverInterval) {
            clearInterval(this._bluezDiscoverInterval);
        }
        this._bluezDiscoverInterval = setInterval(() => {
            this._bluezReportKnownDevices().catch(() => {});
        }, 2000);
    }

    async _bluezConnect (params) {
        await this._bluezInit();
        const peripheral = this.reportedPeripherals[params.peripheralId] || {path: params.peripheralId};
        if (!peripheral.path) {
            throw new Error(`invalid peripheral ID: ${params.peripheralId}`);
        }

        const adapter = await this._bluezGetInterface(this._bluezAdapterPath, BLUEZ_ADAPTER_IFACE);
        try {
            await adapter.StopDiscovery();
        } catch (err) {
            // Discovery may already be stopped.
        }

        const device = await this._bluezGetInterface(peripheral.path, BLUEZ_DEVICE_IFACE);
        await device.Connect();
        this.peripheral = peripheral;
        await this._bluezWaitForCharacteristics(peripheral.path);
    }

    async _bluezRead (params) {
        const characteristic = await this._bluezGetCharacteristic(params.characteristicId);
        if (params.startNotifications) {
            await this._bluezStartNotifications(params);
        }
        const data = await characteristic.iface.ReadValue({});
        return {
            encoding: 'base64',
            message: Buffer.from(data).toString('base64')
        };
    }

    async _bluezStartNotifications (params) {
        const characteristic = await this._bluezGetCharacteristic(params.characteristicId);
        const properties = await this._bluezGetInterface(characteristic.path, DBUS_PROPERTIES_IFACE);
        properties.removeAllListeners('PropertiesChanged');
        properties.on('PropertiesChanged', (iface, changed) => {
            if (iface !== BLUEZ_CHARACTERISTIC_IFACE || !changed.Value) {
                return;
            }
            this.sendRemoteRequest('characteristicDidChange', {
                encoding: 'base64',
                message: Buffer.from(changed.Value.value).toString('base64')
            });
        });
        await characteristic.iface.StartNotify();
    }

    async _bluezWrite (params) {
        const characteristic = await this._bluezGetCharacteristic(params.characteristicId);
        const buffer = params.encoding ? Buffer.from(params.message, params.encoding) : Buffer.from(params.message);
        await characteristic.iface.WriteValue(Array.from(buffer), {});
        return buffer.length;
    }

    async _bluezDisconnect () {
        if (this._bluezDiscoverInterval) {
            clearInterval(this._bluezDiscoverInterval);
            this._bluezDiscoverInterval = null;
        }

        if (this._bluezObjectManager && this._bluezInterfacesAddedHandler) {
            this._bluezObjectManager.removeListener('InterfacesAdded', this._bluezInterfacesAddedHandler);
            this._bluezInterfacesAddedHandler = null;
        }

        if (this._bluezBus && this._bluezAdapterPath) {
            try {
                const adapter = await this._bluezGetInterface(this._bluezAdapterPath, BLUEZ_ADAPTER_IFACE);
                await adapter.StopDiscovery();
            } catch (err) {
                // Discovery may already be stopped.
            }
        }

        if (this.peripheral && this.peripheral.path) {
            try {
                const device = await this._bluezGetInterface(this.peripheral.path, BLUEZ_DEVICE_IFACE);
                await device.Disconnect();
            } catch (err) {
                // Device may already be disconnected.
            }
        }

        this.peripheral = null;
        this.characteristics = {};
    }

    async _bluezInit () {
        if (!dbus) {
            dbus = require('dbus-next'); // eslint-disable-line global-require
        }
        if (!this._bluezBus) {
            this._bluezBus = dbus.systemBus();
        }
        const root = await this._bluezBus.getProxyObject(BLUEZ_SERVICE, '/');
        this._bluezObjectManager = root.getInterface(DBUS_OBJECT_MANAGER_IFACE);
        this._bluezObjects = await this._bluezObjectManager.GetManagedObjects();
        const adapterPath = Object.keys(this._bluezObjects)
            .find(path => this._bluezObjects[path][BLUEZ_ADAPTER_IFACE]);
        if (!adapterPath) {
            throw new Error('Bluetooth adapter is not available');
        }
        this._bluezAdapterPath = adapterPath;
    }

    async _bluezRefreshObjects () {
        await this._bluezInit();
        this._bluezObjects = await this._bluezObjectManager.GetManagedObjects();
        return this._bluezObjects;
    }

    async _bluezReportKnownDevices () {
        const objects = await this._bluezRefreshObjects();
        Object.keys(objects).forEach(path => {
            const device = objects[path][BLUEZ_DEVICE_IFACE];
            if (device) {
                this._bluezReportDevice(path, device);
            }
        });
    }

    _bluezReportDevice (path, deviceProps) {
        const device = this._bluezDeviceFromProps(path, deviceProps);
        if (!device || !this._bluezMatchesDevice(device)) {
            return;
        }
        this.reportedPeripherals[device.peripheralId] = device;
        this.sendRemoteRequest('didDiscoverPeripheral', {
            peripheralId: device.peripheralId,
            name: device.name,
            rssi: device.rssi
        });
    }

    _bluezDeviceFromProps (path, props) {
        const prop = name => {
            if (props[name]) {
                return props[name].value;
            }
            return null;
        };
        const address = prop('Address');
        const alias = prop('Alias');
        const name = prop('Name') || alias || address || path;
        return {
            peripheralId: path,
            path,
            address,
            name,
            rssi: prop('RSSI') || 0,
            serviceUuids: prop('UUIDs') || []
        };
    }

    _bluezMatchesDevice (device) {
        if (this._listAll) {
            return true;
        }
        const serviceUuids = device.serviceUuids.map(normalizeUuid);
        if (this._scanServices.some(service => serviceUuids.indexOf(service) > -1)) {
            return true;
        }
        return MICROBIT_NAME_RE.test(device.name || '');
    }

    async _bluezWaitForCharacteristics (devicePath) {
        const startedAt = Date.now();
        while (Date.now() - startedAt < 10000) {
            const objects = await this._bluezRefreshObjects();
            this.characteristics = {};
            Object.keys(objects).forEach(path => {
                if (path.indexOf(`${devicePath}/`) !== 0) {
                    return;
                }
                const characteristic = objects[path][BLUEZ_CHARACTERISTIC_IFACE];
                if (characteristic && characteristic.UUID) {
                    this.characteristics[normalizeUuid(characteristic.UUID.value)] = {path};
                }
            });
            if (Object.keys(this.characteristics).length) {
                return;
            }
            await new Promise(resolve => setTimeout(resolve, 500));
        }
        throw new Error('BLE characteristics were not discovered');
    }

    async _bluezGetCharacteristic (characteristicId) {
        const characteristic = this.characteristics[normalizeUuid(characteristicId)];
        if (!characteristic) {
            throw new Error(`BLE characteristic not found: ${characteristicId}`);
        }
        characteristic.iface = await this._bluezGetInterface(characteristic.path, BLUEZ_CHARACTERISTIC_IFACE);
        return characteristic;
    }

    async _bluezGetInterface (path, iface) {
        const obj = await this._bluezBus.getProxyObject(BLUEZ_SERVICE, path);
        return obj.getInterface(iface);
    }
}

module.exports = BLESession;
