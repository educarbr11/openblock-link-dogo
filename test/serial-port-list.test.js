const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {listSerialPorts, listSysfsUsbSerialPorts} = require('../src/lib/serial-port-list');

// Builds a sysfs tree shaped like the kernel's: /sys/class/tty/<name> links into the USB
// device tree, and `device` points at the interface (ACM) or usb-serial port (CH340).
const makeFakeSystem = () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'serial-port-list-'));
    const sysfsRoot = path.join(root, 'sys');
    const devRoot = path.join(root, 'dev');
    const write = (file, content) => {
        fs.mkdirSync(path.dirname(file), {recursive: true});
        fs.writeFileSync(file, content);
    };
    const usbDevice = (name, vendorId, productId) => {
        const dir = path.join(sysfsRoot, 'devices', 'usb1', name);
        write(path.join(dir, 'idVendor'), `${vendorId}\n`);
        write(path.join(dir, 'idProduct'), `${productId}\n`);
        return dir;
    };
    const ttyLink = (ttyName, ttyDir, deviceTarget) => {
        fs.mkdirSync(ttyDir, {recursive: true});
        fs.symlinkSync(path.relative(ttyDir, deviceTarget), path.join(ttyDir, 'device'));
        fs.mkdirSync(path.join(sysfsRoot, 'class', 'tty'), {recursive: true});
        fs.symlinkSync(path.relative(path.join(sysfsRoot, 'class', 'tty'), ttyDir),
            path.join(sysfsRoot, 'class', 'tty', ttyName));
        write(path.join(devRoot, ttyName), '');
    };

    const ch340 = usbDevice('1-1', '1a86', '7523');
    const ch340Port = path.join(ch340, '1-1:1.0', 'ttyUSB0');
    ttyLink('ttyUSB0', path.join(ch340Port, 'tty', 'ttyUSB0'), ch340Port);

    const uno = usbDevice('1-2', '2341', '0043');
    const unoInterface = path.join(uno, '1-2:1.0');
    ttyLink('ttyACM0', path.join(unoInterface, 'tty', 'ttyACM0'), unoInterface);

    const platformSerial = path.join(sysfsRoot, 'devices', 'platform', 'serial8250');
    ttyLink('ttyS0', path.join(platformSerial, 'tty', 'ttyS0'), platformSerial);

    return {sysfsRoot, devRoot};
};

const fakeSerialPort = list => ({list});

(async () => {
    const options = Object.assign({platform: 'linux'}, makeFakeSystem());
    const devPath = name => path.join(options.devRoot, name);

    const sysfsPorts = listSysfsUsbSerialPorts(options);
    assert.deepStrictEqual(sysfsPorts.map(port => [port.path, port.vendorId, port.productId]).sort(), [
        [devPath('ttyACM0'), '2341', '0043'],
        [devPath('ttyUSB0'), '1a86', '7523']
    ]);

    // udev listed the CH340 without USB ids and missed the ACM board entirely.
    const merged = await listSerialPorts(fakeSerialPort(() => Promise.resolve([
        {path: devPath('ttyUSB0'), manufacturer: '1a86'}
    ])), options);
    const byPath = Object.fromEntries(merged.map(port => [port.path, port]));
    assert.strictEqual(byPath[devPath('ttyUSB0')].vendorId, '1a86');
    assert.strictEqual(byPath[devPath('ttyUSB0')].productId, '7523');
    assert.strictEqual(byPath[devPath('ttyUSB0')].manufacturer, '1a86');
    assert.strictEqual(byPath[devPath('ttyACM0')].vendorId, '2341');
    assert.strictEqual(merged.length, 2);

    // Ids reported by udev are kept.
    const fromUdev = await listSerialPorts(fakeSerialPort(() => Promise.resolve([
        {path: devPath('ttyUSB0'), vendorId: '1A86', productId: '7522'}
    ])), options);
    assert.strictEqual(fromUdev.find(port => port.path === devPath('ttyUSB0')).productId, '7522');

    // udevadm missing or failing still lists the boards.
    const withoutUdev = await listSerialPorts(fakeSerialPort(() => Promise.reject(new Error('spawn udevadm ENOENT'))),
        options);
    assert.strictEqual(withoutUdev.length, 2);

    // Other platforms use SerialPort.list() as is.
    const windows = await listSerialPorts(fakeSerialPort(() => Promise.resolve([{path: 'COM3'}])),
        Object.assign({}, options, {platform: 'win32'}));
    assert.deepStrictEqual(windows, [{path: 'COM3'}]);

    console.log('Serial port list tests passed.');
})().catch(error => {
    console.error(error);
    process.exit(1);
});
