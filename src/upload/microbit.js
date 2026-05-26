const fs = require('fs');
const {spawn} = require('child_process');
const path = require('path');
const ansi = require('ansi-string');
const os = require('os');

const FLASH_TIME = 25 * 1000; // 20s

const ABORT_STATE_CHECK_INTERVAL = 100;

const UFLASH_MODULE_NAME = 'uflash';
const MICROFS_MODULE_NAME = 'microfs';
const REALTIME_FIRMWARE = `
from microbit import *

uart.init(baudrate=115200)

VERSION = 'microbit-realtime-v2'

PINS = {
    '0': pin0,
    '1': pin1,
    '2': pin2,
    '3': pin3,
    '4': pin4,
    '5': pin5,
    '6': pin6,
    '7': pin7,
    '8': pin8,
    '9': pin9,
    '10': pin10,
    '11': pin11,
    '12': pin12,
    '13': pin13,
    '14': pin14,
    '15': pin15,
    '16': pin16
}


def _ok(value=1):
    uart.write('OK {}\\n'.format(value))


def _err(code):
    uart.write('ERR {}\\n'.format(code))


def _pin(name):
    if name in PINS:
        return PINS[name]
    _err('pin')
    return None


def _clamp(value, minimum, maximum):
    value = int(value)
    if value < minimum:
        return minimum
    if value > maximum:
        return maximum
    return value


def _safe_button(button):
    try:
        return 1 if button.is_pressed() else 0
    except Exception:
        return 0


def _safe_touch(pin):
    try:
        return 1 if pin.is_touched() else 0
    except Exception:
        return 0


def _gesture_name():
    try:
        return accelerometer.current_gesture().replace(' ', '')
    except Exception:
        return ''


def _handle(line):
    parts = line.split()
    if len(parts) == 0:
        return

    cmd = parts[0]

    if cmd == 'PING':
        _ok(1)
    elif cmd == 'VER':
        _ok(VERSION)
    elif cmd == 'DREAD' and len(parts) == 2:
        pin = _pin(parts[1])
        if pin is not None:
            _ok(pin.read_digital())
    elif cmd == 'AREAD' and len(parts) == 2:
        pin = _pin(parts[1])
        if pin is not None:
            _ok(pin.read_analog())
    elif cmd == 'DWRITE' and len(parts) == 3:
        pin = _pin(parts[1])
        if pin is not None:
            pin.write_digital(_clamp(parts[2], 0, 1))
            _ok(1)
    elif cmd == 'PWM' and len(parts) == 3:
        pin = _pin(parts[1])
        if pin is not None:
            pin.write_analog(_clamp(parts[2], 0, 1023))
            _ok(1)
    elif cmd == 'TOUCH' and len(parts) == 2:
        pin = _pin(parts[1])
        if pin is not None:
            _ok(_safe_touch(pin))
    elif cmd == 'BTN' and len(parts) == 2:
        key = parts[1].upper()
        if key == 'A':
            _ok(_safe_button(button_a))
        elif key == 'B':
            _ok(_safe_button(button_b))
        else:
            _err('button')
    elif cmd == 'POLL':
        a = _safe_button(button_a)
        b = _safe_button(button_b)
        ab = 1 if a and b else 0
        t0 = _safe_touch(pin0)
        t1 = _safe_touch(pin1)
        t2 = _safe_touch(pin2)
        _ok('{},{},{},{},{},{},{}'.format(a, b, ab, t0, t1, t2, _gesture_name()))
    elif cmd == 'GEST' and len(parts) == 2:
        _ok(1 if _gesture_name() == parts[1].lower() else 0)
    elif cmd == 'ACC' and len(parts) == 2:
        axis = parts[1].upper()
        if axis == 'X':
            _ok(accelerometer.get_x())
        elif axis == 'Y':
            _ok(accelerometer.get_y())
        elif axis == 'Z':
            _ok(accelerometer.get_z())
        else:
            _err('axis')
    elif cmd == 'LIGHT':
        _ok(display.read_light_level())
    elif cmd == 'TEMP':
        _ok(temperature())
    elif cmd == 'TIME':
        _ok(running_time())
    elif cmd == 'IMG' and len(parts) == 2:
        value = parts[1]
        if len(value) != 25:
            _err('image')
            return
        rows = []
        for row in range(5):
            row_value = ''
            for col in range(5):
                row_value = row_value + ('9' if value[row * 5 + col] == '1' else '0')
            rows.append(row_value)
        display.show(Image(':'.join(rows)))
        _ok(1)
    elif cmd == 'CLEAR':
        display.clear()
        _ok(1)
    else:
        _err('cmd')


while True:
    try:
        data = uart.readline()
        if data:
            _handle(data.decode('utf-8').strip())
    except Exception:
        _err('bad')
    sleep(10)
`;

class Microbit {
    constructor (peripheralPath, config, userDataPath, toolsPath, sendstd, sendRemoteRequest) {
        this._peripheralPath = peripheralPath;
        this._config = config;
        this._userDataPath = userDataPath;
        this._projectPath = path.join(userDataPath, 'microbit/project');
        this._pythonPath = path.join(toolsPath, 'Python');
        this._sendstd = sendstd;
        this._sendRemoteRequest = sendRemoteRequest;

        this._abort = false;

        if (os.platform() === 'darwin') {
            this._pyPath = path.join(this._pythonPath, 'python3');
        } else if (os.platform() === 'linux') {
            this._pyPath = path.join(this._pythonPath, 'bin/python3');
        } else {
            this._pyPath = path.join(this._pythonPath, 'python');
        }

        this._codefilePath = path.join(this._projectPath, 'main.py');
    }

    abortUpload () {
        this._abort = true;
    }

    async flash (code) {
        const fileToPut = [];

        if (!fs.existsSync(this._projectPath)) {
            fs.mkdirSync(this._projectPath, {recursive: true});
        }

        try {
            fs.writeFileSync(this._codefilePath, code);
        } catch (err) {
            return Promise.reject(err);
        }

        fileToPut.push(this._codefilePath);

        this._config.library.forEach(lib => {
            if (fs.existsSync(lib)) {
                const libraries = fs.readdirSync(lib);
                libraries.forEach(file => {
                    fileToPut.push(path.join(lib, file));
                });
            }
        });

        const ufsTestExitCode = await this.ufsTestFirmware();
        if (ufsTestExitCode === 'Failed') {
            this._sendstd(`${ansi.yellow_dark}Could not enter raw REPL.\n`);
            this._sendstd(`${ansi.clear}Try to flash micropython for microbit firmware to fix.\n`);
            await this.uflash();
        }

        if (this._abort === true) {
            return Promise.resolve('Aborted');
        }

        this._sendstd('Writing files...\n');

        for (const file of fileToPut) {
            const ufsPutExitCode = await this.ufsPut(file);
            if (ufsPutExitCode !== 'Success' && ufsPutExitCode !== 'Aborted') {
                return Promise.reject(ufsPutExitCode);
            }
            if (this._abort === true) {
                break;
            }
        }

        if (this._abort === true) {
            return Promise.resolve('Aborted');
        }
        this._sendstd(`${ansi.green_dark}Success\n`);
        return Promise.resolve('Success');
    }

    async flashRealtimeFirmware () {
        const library = this._config.library;
        this._config.library = [];
        try {
            this._sendstd('Writing microbit realtime firmware...\n');
            return await this.flash(REALTIME_FIRMWARE);
        } finally {
            this._config.library = library;
        }
    }

    ufsTestFirmware () {
        this._sendstd(`Try to enter raw REPL.\n`);

        return new Promise(resolve => {
            const ufs = spawn(this._pyPath, ['-m', MICROFS_MODULE_NAME, 'ls']);

            const listenAbortSignal = setInterval(() => {
                if (this._abort) {
                    ufs.kill();
                }
            }, ABORT_STATE_CHECK_INTERVAL);

            ufs.on('exit', outCode => {
                clearInterval(listenAbortSignal);
                switch (outCode) {
                case null:
                    return resolve('Aborted');
                case 0:
                    return resolve('Success');
                case 1: // Could not enter raw REPL.
                    return resolve('Failed');
                }
            });
        });
    }

    ufsPut (file) {
        return new Promise((resolve, reject) => {
            const ufs = spawn(this._pyPath, ['-m', MICROFS_MODULE_NAME, 'put', file]);

            ufs.stdout.on('data', buf => {
                this._sendstd(ansi.red + buf.toString());
                return resolve('Failed');
            });

            const listenAbortSignal = setInterval(() => {
                if (this._abort) {
                    ufs.kill();
                }
            }, ABORT_STATE_CHECK_INTERVAL);

            ufs.on('exit', outCode => {
                clearInterval(listenAbortSignal);
                switch (outCode) {
                case null:
                    return resolve('Aborted');
                case 0:
                    this._sendstd(`${file} write finish\n`);
                    return resolve('Success');
                case 1:
                    return reject('ufs failed to write');
                }
            });
        });
    }

    uflash () {
        return new Promise((resolve, reject) => {
            // For some unknown reason, uflash cannot be killed in the test, so the termination button is disabled
            // when uflash is running.
            this._sendRemoteRequest('setUploadAbortEnabled', false);

            const uflash = spawn(this._pyPath, ['-m', UFLASH_MODULE_NAME]);

            this._sendstd(`${ansi.green_dark}Start flash firmware...\n`);
            this._sendstd(`${ansi.clear}This step will take tens of seconds, pelese wait.\n`);

            // Add finish flasg to solve uflash will exit immediately after start, nut not exit
            // after flash finish. So add a counter flag in order to ensure that enough time has
            // been spent to finish burning and uflash runs successfully.
            let finishFlag = 0;
            const finish = () => {
                finishFlag += 1;
                if (finishFlag === 2) {
                    this._sendstd(`${ansi.green_dark}Flash Success.\n`);
                    return resolve('Success');
                }
            };
            setTimeout(finish, FLASH_TIME);

            uflash.stdout.on('data', buf => {
                this._sendstd(buf.toString());
            });

            uflash.stderr.on('data', buf => {
                this._sendstd(ansi.red + buf.toString());
            });

            uflash.on('exit', outCode => {
                switch (outCode) {
                case 0:
                    finish();
                    break;
                case 1:
                    return reject('uflash failed to flash');
                }
            });
        });
    }
}

module.exports = Microbit;
