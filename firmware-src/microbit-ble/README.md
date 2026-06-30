# Dogoblock micro:bit BLE v1 firmware

Firmware for micro:bit v1 and v2 that exposes the Scratch BLE service used by the
Dogoblock `microbitBle` extension:

- service `0xf005`
- RX notify characteristic `5261da01-fa7e-42ab-850b-7c80220097cc`
- TX write characteristic `5261da02-fa7e-42ab-850b-7c80220097cc`

Supported commands:

- `0x80 [pin, value]`: digital write on P0/P1/P2, value `0` or `1`
- `0x81 [text...]`: scroll text on the LED matrix
- `0x82 [row0..row4]`: show a 5x5 LED matrix
- `0x83 [pin, valueHi, valueLo]`: PWM write on P0/P1/P2, value `0..1023`
- `0x84 [enabled]`: enable extended telemetry packets when `enabled` is `1`

The firmware sends the 10-byte sensor packet expected by the VM:

- bytes `0..1`: tilt X, signed int16 big-endian, in tenths of a degree
- bytes `2..3`: tilt Y, signed int16 big-endian, in tenths of a degree
- byte `4`: button A, `0` or `1`
- byte `5`: button B, `0` or `1`
- byte `6`: P0 state, `0` or `1`
- byte `7`: P1 state, `0` or `1`
- byte `8`: P2 state, `0` or `1`
- byte `9`: gesture bitfield, bit `0` shaken, bit `1` jumped/freefall, bit `2` moved

When extended telemetry is enabled by command `0x84`, the firmware also sends a
20-byte packet with marker/version bytes:

- byte `0`: marker `0xd0`
- byte `1`: version `1`
- bytes `2..3`: analog P0, uint16 big-endian, `0..1023`
- bytes `4..5`: analog P1, uint16 big-endian, `0..1023`
- bytes `6..7`: analog P2, uint16 big-endian, `0..1023`
- bytes `8..9`: acceleration X, int16 big-endian
- bytes `10..11`: acceleration Y, int16 big-endian
- bytes `12..13`: acceleration Z, int16 big-endian
- byte `14`: temperature in Celsius, signed int8
- byte `15`: light level, uint8, `0..255`
- bytes `16..19`: running time in milliseconds, uint32 big-endian

When a pin has been used as digital output through `0x80`, its sensor packet
state reports the latest output value instead of reading touch state. This keeps
the pin stable as output and avoids reconfiguring it back to touch input.

Build from `openblock-link`:

```sh
npm run build:firmware:microbit-ble
```

The generated hex files are copied to:

```text
firmwares/microbit/dogoblock-microbit-ble.hex
firmwares/microbit/dogoblock-microbit-ble-v2.hex
```
