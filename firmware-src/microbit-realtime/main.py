from microbit import *

uart.init(baudrate=115200)

VERSION = 'microbit-realtime-v2'


def _ok(value=1):
    uart.write('OK ')
    uart.write(str(value))
    uart.write('\n')


def _err(code):
    uart.write('ERR ')
    uart.write(str(code))
    uart.write('\n')


def _pin(name):
    if name == '0':
        return pin0
    if name == '1':
        return pin1
    if name == '2':
        return pin2
    if name == '3':
        return pin3
    if name == '4':
        return pin4
    if name == '5':
        return pin5
    if name == '6':
        return pin6
    if name == '7':
        return pin7
    if name == '8':
        return pin8
    if name == '9':
        return pin9
    if name == '10':
        return pin10
    if name == '11':
        return pin11
    if name == '12':
        return pin12
    if name == '13':
        return pin13
    if name == '14':
        return pin14
    if name == '15':
        return pin15
    if name == '16':
        return pin16
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


def _safe_button_event(button):
    try:
        return 1 if button.was_pressed() or button.is_pressed() else 0
    except Exception:
        return _safe_button(button)


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


def _hex_to_text(hex_text):
    data = bytearray()
    for index in range(0, len(hex_text), 2):
        data.append(int(hex_text[index:index + 2], 16))
    return data.decode('utf-8')


def _show_text(hex_text, wait):
    try:
        text = _hex_to_text(hex_text)
        if wait:
            display.scroll(text, wait=True)
        else:
            display.scroll(text, wait=False)
        _ok(1)
    except Exception:
        _err('text')


def _set_pixel(x, y, brightness):
    try:
        display.set_pixel(
            _clamp(x, 0, 4),
            _clamp(y, 0, 4),
            _clamp(brightness, 0, 9)
        )
        _ok(1)
    except Exception:
        _err('pixel')


def _show_image(value):
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
        a = _safe_button_event(button_a)
        b = _safe_button_event(button_b)
        ab = 1 if a and b else 0
        t0 = _safe_touch(pin0)
        t1 = _safe_touch(pin1)
        t2 = _safe_touch(pin2)
        _ok(str(a) + ',' + str(b) + ',' + str(ab) + ',' + str(t0) + ',' +
            str(t1) + ',' + str(t2) + ',' + _gesture_name())
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
        _show_image(parts[1])
    elif cmd == 'TEXT' and len(parts) == 2:
        _show_text(parts[1], False)
    elif cmd == 'TEXTWAIT' and len(parts) == 2:
        _show_text(parts[1], True)
    elif cmd == 'PIXEL' and len(parts) == 4:
        _set_pixel(parts[1], parts[2], parts[3])
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
