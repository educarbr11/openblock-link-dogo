#include "DogoblockScratchService.h"

using namespace pxt;

static DogoblockScratchService *service = NULL;

const uint8_t DogoblockRxCharacteristicUUID[] = {
    0x52, 0x61, 0xda, 0x01, 0xfa, 0x7e, 0x42, 0xab,
    0x85, 0x0b, 0x7c, 0x80, 0x22, 0x00, 0x97, 0xcc
};

const uint8_t DogoblockTxCharacteristicUUID[] = {
    0x52, 0x61, 0xda, 0x02, 0xfa, 0x7e, 0x42, 0xab,
    0x85, 0x0b, 0x7c, 0x80, 0x22, 0x00, 0x97, 0xcc
};

#if MICROBIT_CODAL

const uint8_t DogoblockScratchService::char_base_uuid[16] = {
    0x52, 0x61, 0x00, 0x00, 0xfa, 0x7e, 0x42, 0xab,
    0x85, 0x0b, 0x7c, 0x80, 0x22, 0x00, 0x97, 0xcc
};

const uint16_t DogoblockScratchService::charUUID[mbbs_cIdxCOUNT] = {0xda01, 0xda02};

DogoblockScratchService::DogoblockScratchService()
{
    memset(sensorPacket, 0, sizeof(sensorPacket));
    memset(commandBuffer, 0, sizeof(commandBuffer));
    memset(pinOutputEnabled, 0, sizeof(pinOutputEnabled));
    memset(pinOutputValue, 0, sizeof(pinOutputValue));

    CreateService(0xf005);

    RegisterBaseUUID(char_base_uuid);
    CreateCharacteristic(
        mbbs_cIdxRX,
        charUUID[mbbs_cIdxRX],
        sensorPacket,
        0,
        sizeof(sensorPacket),
        microbit_propNOTIFY
    );

    CreateCharacteristic(
        mbbs_cIdxTX,
        charUUID[mbbs_cIdxTX],
        commandBuffer,
        0,
        sizeof(commandBuffer),
        microbit_propWRITE | microbit_propWRITE_WITHOUT
    );
}

void DogoblockScratchService::notifySensorPacket(const uint8_t *data, int len) {
    if (data == NULL) return;
    if (len > DOGOBLOCK_SENSOR_PACKET_LENGTH) len = DOGOBLOCK_SENSOR_PACKET_LENGTH;
    if (len < 0) return;
    memset(sensorPacket, 0, sizeof(sensorPacket));
    memcpy(sensorPacket, data, len);
    setChrValue(mbbs_cIdxRX, sensorPacket, sizeof(sensorPacket));
    notifyChrValue(mbbs_cIdxRX, sensorPacket, sizeof(sensorPacket));
}

int DogoblockScratchService::getPinOutputValue(int pin) {
    if (pin < 0 || pin > 2) return -1;
    if (!pinOutputEnabled[pin]) return -1;
    return pinOutputValue[pin] ? 1 : 0;
}

void DogoblockScratchService::onDataWritten(const microbit_ble_evt_write_t *params) {
    if (params == NULL || params->handle != valueHandle(mbbs_cIdxTX) || params->data == NULL) return;
    handleCommand(params->data, params->len);
}

void DogoblockScratchService::handleCommand(const uint8_t *data, int len) {
    if (data == NULL || len <= 0) return;

    uint8_t command = data[0];
    const uint8_t *payload = data + 1;
    int payloadLength = len - 1;

    switch (command) {
        case 0x80:
            handlePinWrite(payload, payloadLength);
            break;
        case 0x81:
            handleDisplayText(payload, payloadLength);
            break;
        case 0x82:
            handleDisplayLed(payload, payloadLength);
            break;
        default:
            break;
    }
}

void DogoblockScratchService::handlePinWrite(const uint8_t *data, int len) {
    if (data == NULL || len < 2) return;
    if (data[0] > 2 || data[1] > 1) return;

    Pin *pin = NULL;
    if (data[0] == 0) pin = &uBit.io.P0;
    if (data[0] == 1) pin = &uBit.io.P1;
    if (data[0] == 2) pin = &uBit.io.P2;
    if (pin == NULL) return;

    pinOutputEnabled[data[0]] = 1;
    pinOutputValue[data[0]] = data[1] ? 1 : 0;
    pin->setDigitalValue(pinOutputValue[data[0]]);
}

void DogoblockScratchService::handleDisplayText(const uint8_t *data, int len) {
    if (data == NULL || len <= 0) {
        uBit.display.clear();
        return;
    }

    ManagedString s((char *)data, len);
    uBit.display.stopAnimation();
    uBit.display.scrollAsync(s);
}

void DogoblockScratchService::handleDisplayLed(const uint8_t *data, int len) {
    if (data == NULL || len < 5) {
        uBit.display.clear();
        return;
    }

    uBit.display.stopAnimation();
    uBit.display.image.clear();
    for (int y = 0; y < 5; y++) {
        uint8_t row = data[y];
        for (int x = 0; x < 5; x++) {
            int enabled = (row & (1 << (4 - x))) ? 255 : 0;
            uBit.display.image.setPixelValue(x, y, enabled);
        }
    }
}

#else

DogoblockScratchService::DogoblockScratchService(BLEDevice &_ble) :
    ble(_ble),
    rxCharacteristicHandle(0),
    txCharacteristicHandle(0)
{
    memset(sensorPacket, 0, sizeof(sensorPacket));
    memset(commandBuffer, 0, sizeof(commandBuffer));
    memset(pinOutputEnabled, 0, sizeof(pinOutputEnabled));
    memset(pinOutputValue, 0, sizeof(pinOutputValue));

    GattCharacteristic rxCharacteristic(
        DogoblockRxCharacteristicUUID,
        sensorPacket,
        0,
        sizeof(sensorPacket),
        GattCharacteristic::BLE_GATT_CHAR_PROPERTIES_NOTIFY
    );

    GattCharacteristic txCharacteristic(
        DogoblockTxCharacteristicUUID,
        commandBuffer,
        0,
        sizeof(commandBuffer),
        GattCharacteristic::BLE_GATT_CHAR_PROPERTIES_WRITE |
            GattCharacteristic::BLE_GATT_CHAR_PROPERTIES_WRITE_WITHOUT_RESPONSE
    );

    GattCharacteristic *characteristics[] = {&rxCharacteristic, &txCharacteristic};
    GattService scratchService(0xf005, characteristics, sizeof(characteristics) / sizeof(GattCharacteristic *));
    ble.addService(scratchService);

    rxCharacteristicHandle = rxCharacteristic.getValueHandle();
    txCharacteristicHandle = txCharacteristic.getValueHandle();

    ble.gattServer().write(rxCharacteristicHandle, sensorPacket, sizeof(sensorPacket));
    ble.onDataWritten(this, &DogoblockScratchService::onDataWritten);
}

void DogoblockScratchService::notifySensorPacket(const uint8_t *data, int len) {
    if (!ble.getGapState().connected || data == NULL) return;
    if (len > DOGOBLOCK_SENSOR_PACKET_LENGTH) len = DOGOBLOCK_SENSOR_PACKET_LENGTH;
    if (len < 0) return;
    memset(sensorPacket, 0, sizeof(sensorPacket));
    memcpy(sensorPacket, data, len);
    ble.gattServer().write(rxCharacteristicHandle, sensorPacket, sizeof(sensorPacket));
    ble.gattServer().notify(rxCharacteristicHandle, sensorPacket, sizeof(sensorPacket));
}

int DogoblockScratchService::getPinOutputValue(int pin) {
    if (pin < 0 || pin > 2) return -1;
    if (!pinOutputEnabled[pin]) return -1;
    return pinOutputValue[pin] ? 1 : 0;
}

void DogoblockScratchService::onDataWritten(const GattWriteCallbackParams *params) {
    if (params == NULL || params->handle != txCharacteristicHandle || params->data == NULL) return;
    handleCommand(params->data, params->len);
}

void DogoblockScratchService::handleCommand(const uint8_t *data, int len) {
    if (data == NULL || len <= 0) return;

    uint8_t command = data[0];
    const uint8_t *payload = data + 1;
    int payloadLength = len - 1;

    switch (command) {
        case 0x80:
            handlePinWrite(payload, payloadLength);
            break;
        case 0x81:
            handleDisplayText(payload, payloadLength);
            break;
        case 0x82:
            handleDisplayLed(payload, payloadLength);
            break;
        default:
            break;
    }
}

void DogoblockScratchService::handlePinWrite(const uint8_t *data, int len) {
    if (data == NULL || len < 2) return;
    if (data[0] > 2 || data[1] > 1) return;

    MicroBitPin *pin = NULL;
    if (data[0] == 0) pin = &uBit.io.P0;
    if (data[0] == 1) pin = &uBit.io.P1;
    if (data[0] == 2) pin = &uBit.io.P2;
    if (pin == NULL) return;

    pinOutputEnabled[data[0]] = 1;
    pinOutputValue[data[0]] = data[1] ? 1 : 0;
    pin->setDigitalValue(pinOutputValue[data[0]]);
}

void DogoblockScratchService::handleDisplayText(const uint8_t *data, int len) {
    if (data == NULL || len <= 0) {
        uBit.display.clear();
        return;
    }

    char text[DOGOBLOCK_MAX_COMMAND_LENGTH];
    int textLength = len;
    if (textLength >= DOGOBLOCK_MAX_COMMAND_LENGTH) textLength = DOGOBLOCK_MAX_COMMAND_LENGTH - 1;
    memcpy(text, data, textLength);
    text[textLength] = 0;
    uBit.display.scroll(ManagedString(text));
}

void DogoblockScratchService::handleDisplayLed(const uint8_t *data, int len) {
    if (data == NULL || len < 5) {
        uBit.display.clear();
        return;
    }

    uBit.display.image.clear();
    for (int y = 0; y < 5; y++) {
        uint8_t row = data[y];
        for (int x = 0; x < 5; x++) {
            int enabled = (row & (1 << (4 - x))) ? 255 : 0;
            uBit.display.image.setPixelValue(x, y, enabled);
        }
    }
    uBit.display.print(uBit.display.image);
}

#endif

namespace dogoblockble {
    //%
    void startService() {
#if MICROBIT_CODAL
        if (service == NULL) service = new DogoblockScratchService();
#else
        if (service == NULL) service = new DogoblockScratchService(*uBit.ble);
#endif
    }

    //%
    void notifySensorPacket(Buffer packet) {
        startService();
        if (packet == NULL || service == NULL) return;
        service->notifySensorPacket(packet->data, packet->length);
    }

    //%
    int getPinOutputValue(int pin) {
        startService();
        if (service == NULL) return -1;
        return service->getPinOutputValue(pin);
    }
}
