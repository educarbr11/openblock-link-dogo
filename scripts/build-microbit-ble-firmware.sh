#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SRC_DIR="$ROOT_DIR/firmware-src/microbit-ble"
OUT_DIR="$ROOT_DIR/firmwares/microbit"
BUILD_DIR="${DOGOBLOCK_MICROBIT_BLE_BUILD_DIR:-$(mktemp -d)}"

if ! command -v pxt >/dev/null 2>&1; then
    echo "pxt CLI not found. Install it before building the micro:bit BLE firmware." >&2
    exit 1
fi

mkdir -p "$BUILD_DIR" "$OUT_DIR"
cp "$SRC_DIR"/* "$BUILD_DIR"/

(
    cd "$BUILD_DIR"
    pxt target microbit >/dev/null
    pxt install >/dev/null
    pxt build --hwvariant mbdal
    pxt build --hwvariant mbcodal
)

node - "$BUILD_DIR" <<'NODE'
const fs = require('fs');
const path = require('path');

const buildDir = process.argv[2];

const readJson = file => {
    const filePath = path.join(buildDir, 'built', file);
    if (!fs.existsSync(filePath)) {
        throw new Error(`Missing generated config: ${filePath}`);
    }
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
};

const getSourceBluetoothConfig = config => {
    const bluetooth = config &&
        config.yotta &&
        config.yotta.config &&
        config.yotta.config['microbit-dal'] &&
        config.yotta.config['microbit-dal'].bluetooth;
    if (!bluetooth) {
        throw new Error('Missing yotta.config.microbit-dal.bluetooth config in pxt.json');
    }
    return bluetooth;
};

const getCodalBluetoothConfig = config => {
    const definitions = config.definitions || config.config || config;
    return {
        open: definitions.MICROBIT_DAL_BLUETOOTH_OPEN,
        whitelist: definitions.MICROBIT_DAL_BLUETOOTH_WHITELIST,
        pairing_mode: definitions.MICROBIT_DAL_BLUETOOTH_PAIRING_MODE,
        security_level: definitions.MICROBIT_DAL_BLUETOOTH_SECURITY_LEVEL,
        advertising_timeout: definitions.MICROBIT_DAL_BLUETOOTH_ADVERTISING_TIMEOUT
    };
};

const validateOpenBluetooth = (label, bluetooth) => {
    const failures = [];
    if (bluetooth.open !== 1) failures.push(`open=${bluetooth.open}`);
    if (bluetooth.whitelist !== 0) failures.push(`whitelist=${bluetooth.whitelist}`);
    if (bluetooth.pairing_mode !== 0) failures.push(`pairing_mode=${bluetooth.pairing_mode}`);
    if (Object.prototype.hasOwnProperty.call(bluetooth, 'security_level') &&
            bluetooth.security_level !== null &&
            typeof bluetooth.security_level !== 'undefined') {
        failures.push(`security_level=${bluetooth.security_level}`);
    }
    if (Object.prototype.hasOwnProperty.call(bluetooth, 'advertising_timeout') &&
            bluetooth.advertising_timeout !== 0) {
        failures.push(`advertising_timeout=${bluetooth.advertising_timeout}`);
    }

    if (failures.length) {
        throw new Error(`${label} is not configured for open BLE discovery: ${failures.join(', ')}`);
    }
};

validateOpenBluetooth('pxt.json', getSourceBluetoothConfig(readJson('../pxt.json')));
validateOpenBluetooth('codal.json', getCodalBluetoothConfig(readJson('codal.json')));
NODE

cp "$BUILD_DIR/built/mbdal-binary.hex" "$OUT_DIR/dogoblock-microbit-ble.hex"
cp "$BUILD_DIR/built/mbcodal-binary.hex" "$OUT_DIR/dogoblock-microbit-ble-v2.hex"
echo "Generated $OUT_DIR/dogoblock-microbit-ble.hex"
echo "Generated $OUT_DIR/dogoblock-microbit-ble-v2.hex"
