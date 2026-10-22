const fs = require('fs');
const path = require('path');

const USB_SERIAL_TTY = /^tty(USB|ACM)\d+$/;

const readSysfsValue = (dir, name) => {
    try {
        return fs.readFileSync(path.join(dir, name), 'utf8').trim() || null;
    } catch (err) {
        return null;
    }
};

// Walk up from the tty device to the USB device directory, which holds idVendor/idProduct.
const readUsbDeviceInfo = (sysfsRoot, ttyName) => {
    let dir;
    try {
        dir = fs.realpathSync(path.join(sysfsRoot, 'class', 'tty', ttyName, 'device'));
    } catch (err) {
        return null;
    }
    while (dir.startsWith(sysfsRoot) && dir !== sysfsRoot) {
        const vendorId = readSysfsValue(dir, 'idVendor');
        if (vendorId) {
            return {
                vendorId,
                productId: readSysfsValue(dir, 'idProduct'),
                manufacturer: readSysfsValue(dir, 'manufacturer'),
                serialNumber: readSysfsValue(dir, 'serial')
            };
        }
        dir = path.dirname(dir);
    }
    return null;
};

/**
 * List USB serial ports (ttyUSB*, ttyACM*) from sysfs.
 * @param {object} options - test overrides.
 * @param {string} options.sysfsRoot - sysfs mount point.
 * @param {string} options.devRoot - device directory.
 * @returns {Array<object>} ports in the same shape as SerialPort.list().
 */
const listSysfsUsbSerialPorts = ({sysfsRoot = '/sys', devRoot = '/dev'} = {}) => {
    let names;
    try {
        names = fs.readdirSync(path.join(sysfsRoot, 'class', 'tty')).filter(name => USB_SERIAL_TTY.test(name));
    } catch (err) {
        return [];
    }
    return names
        .map(name => Object.assign({path: path.join(devRoot, name)}, readUsbDeviceInfo(sysfsRoot, name)))
        .filter(port => port.vendorId && fs.existsSync(port.path));
};

/**
 * List serial ports. On Linux the serialport binding only reads the udev database, which can
 * miss devices or their USB ids inside containers such as the ChromeOS Linux environment
 * (Crostini); sysfs fills those gaps so boards still match the device filters.
 * @param {object} SerialPort - serialport class with a static list().
 * @param {object} options - test overrides, see listSysfsUsbSerialPorts.
 * @returns {Promise<Array<object>>} the ports.
 */
const listSerialPorts = (SerialPort, options = {}) => {
    const listed = SerialPort.list().catch(() => []);
    if ((options.platform || process.platform) !== 'linux') return listed;
    return listed.then(ports => {
        const sysfsPorts = listSysfsUsbSerialPorts(options);
        const merged = ports.map(port => {
            const sysfsPort = sysfsPorts.find(item => item.path === port.path);
            if (!sysfsPort) return port;
            return Object.assign({}, port, {
                vendorId: port.vendorId || sysfsPort.vendorId,
                productId: port.productId || sysfsPort.productId,
                manufacturer: port.manufacturer || sysfsPort.manufacturer,
                serialNumber: port.serialNumber || sysfsPort.serialNumber
            });
        });
        sysfsPorts.forEach(sysfsPort => {
            if (!merged.some(port => port.path === sysfsPort.path)) merged.push(sysfsPort);
        });
        return merged;
    });
};

module.exports = {
    listSerialPorts,
    listSysfsUsbSerialPorts
};
