#ifndef DOGOBLOCK_SCRATCH_SERVICE_H
#define DOGOBLOCK_SCRATCH_SERVICE_H

#include "MicroBitConfig.h"
#include "pxt.h"

#define DOGOBLOCK_SENSOR_PACKET_LENGTH 20
#define DOGOBLOCK_MAX_COMMAND_LENGTH 20

extern const uint8_t DogoblockRxCharacteristicUUID[];
extern const uint8_t DogoblockTxCharacteristicUUID[];

#if MICROBIT_CODAL

#include "MicroBitBLEManager.h"
#include "MicroBitBLEService.h"

class DogoblockScratchService : public MicroBitBLEService
{
  public:
    DogoblockScratchService();
    void notifySensorPacket(const uint8_t *data, int len);
    void onDataWritten(const microbit_ble_evt_write_t *params);
    int getPinOutputValue(int pin);
    int getExtendedTelemetryEnabled();

  private:
    uint8_t sensorPacket[DOGOBLOCK_SENSOR_PACKET_LENGTH];
    uint8_t commandBuffer[DOGOBLOCK_MAX_COMMAND_LENGTH];
    uint8_t pinOutputEnabled[3];
    uint8_t pinOutputValue[3];
    uint8_t extendedTelemetryEnabled;

    typedef enum mbbs_cIdx
    {
        mbbs_cIdxRX,
        mbbs_cIdxTX,
        mbbs_cIdxCOUNT
    } mbbs_cIdx;

    static const uint8_t char_base_uuid[16];
    static const uint16_t charUUID[mbbs_cIdxCOUNT];

    MicroBitBLEChar chars[mbbs_cIdxCOUNT];

    void handleCommand(const uint8_t *data, int len);
    void handlePinWrite(const uint8_t *data, int len);
    void handlePwmWrite(const uint8_t *data, int len);
    void handleExtendedTelemetry(const uint8_t *data, int len);
    void handleDisplayText(const uint8_t *data, int len);
    void handleDisplayLed(const uint8_t *data, int len);

  public:
    int characteristicCount() { return mbbs_cIdxCOUNT; }
    MicroBitBLEChar *characteristicPtr(int idx) { return &chars[idx]; }
};

#else

#include "ble/BLE.h"

class DogoblockScratchService
{
  public:
    DogoblockScratchService(BLEDevice &_ble);
    void notifySensorPacket(const uint8_t *data, int len);
    int getPinOutputValue(int pin);
    int getExtendedTelemetryEnabled();

  private:
    BLEDevice &ble;
    uint8_t sensorPacket[DOGOBLOCK_SENSOR_PACKET_LENGTH];
    uint8_t commandBuffer[DOGOBLOCK_MAX_COMMAND_LENGTH];
    uint8_t pinOutputEnabled[3];
    uint8_t pinOutputValue[3];
    uint8_t extendedTelemetryEnabled;
    GattAttribute::Handle_t rxCharacteristicHandle;
    GattAttribute::Handle_t txCharacteristicHandle;

    void onDataWritten(const GattWriteCallbackParams *params);
    void handleCommand(const uint8_t *data, int len);
    void handlePinWrite(const uint8_t *data, int len);
    void handlePwmWrite(const uint8_t *data, int len);
    void handleExtendedTelemetry(const uint8_t *data, int len);
    void handleDisplayText(const uint8_t *data, int len);
    void handleDisplayLed(const uint8_t *data, int len);
};

#endif

#endif
