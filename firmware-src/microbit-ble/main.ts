dogoblockble.startService()
basic.showIcon(IconNames.SmallDiamond)

let lastAccelX = input.acceleration(Dimension.X)
let lastAccelY = input.acceleration(Dimension.Y)
let lastAccelZ = input.acceleration(Dimension.Z)
let movedHold = 0
const MOVED_DELTA_THRESHOLD = 300
const MOVED_HOLD_TICKS = 6

function writeInt16BE(buffer: Buffer, offset: number, value: number) {
    if (value < 0) {
        value = 0x10000 + value
    }
    buffer.setNumber(NumberFormat.UInt8BE, offset, (value >> 8) & 0xff)
    buffer.setNumber(NumberFormat.UInt8BE, offset + 1, value & 0xff)
}

function gestureState(): number {
    let state = 0
    const accelX = input.acceleration(Dimension.X)
    const accelY = input.acceleration(Dimension.Y)
    const accelZ = input.acceleration(Dimension.Z)
    const delta = Math.abs(accelX - lastAccelX) +
        Math.abs(accelY - lastAccelY) +
        Math.abs(accelZ - lastAccelZ)

    lastAccelX = accelX
    lastAccelY = accelY
    lastAccelZ = accelZ

    if (delta >= MOVED_DELTA_THRESHOLD) {
        movedHold = MOVED_HOLD_TICKS
    } else if (movedHold > 0) {
        movedHold--
    }

    if (input.isGesture(Gesture.Shake)) state |= 1
    if (input.isGesture(Gesture.FreeFall)) state |= 2
    if (movedHold > 0) state |= 4
    return state
}

function pinState(pin: number, touchPin: TouchPin): number {
    const outputValue = dogoblockble.getPinOutputValue(pin)
    if (outputValue >= 0) return outputValue
    return input.pinIsPressed(touchPin) ? 1 : 0
}

basic.forever(function () {
    const packet = pins.createBuffer(10)
    writeInt16BE(packet, 0, input.rotation(Rotation.Roll) * 10)
    writeInt16BE(packet, 2, input.rotation(Rotation.Pitch) * 10)
    packet.setNumber(NumberFormat.UInt8BE, 4, input.buttonIsPressed(Button.A) ? 1 : 0)
    packet.setNumber(NumberFormat.UInt8BE, 5, input.buttonIsPressed(Button.B) ? 1 : 0)
    packet.setNumber(NumberFormat.UInt8BE, 6, pinState(0, TouchPin.P0))
    packet.setNumber(NumberFormat.UInt8BE, 7, pinState(1, TouchPin.P1))
    packet.setNumber(NumberFormat.UInt8BE, 8, pinState(2, TouchPin.P2))
    packet.setNumber(NumberFormat.UInt8BE, 9, gestureState())
    dogoblockble.notifySensorPacket(packet)
    basic.pause(50)
})
