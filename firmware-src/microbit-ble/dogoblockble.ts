namespace dogoblockble {
    //% shim=dogoblockble::startService
    export function startService(): void {
        return
    }

    //% shim=dogoblockble::notifySensorPacket
    export function notifySensorPacket(packet: Buffer): void {
        return
    }

    //% shim=dogoblockble::getPinOutputValue
    export function getPinOutputValue(pin: number): number {
        return -1
    }

    //% shim=dogoblockble::getExtendedTelemetryEnabled
    export function getExtendedTelemetryEnabled(): number {
        return 0
    }
}
