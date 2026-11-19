const PROTOCOL = 'dogoblock-lan';
const VERSION = 1;
const MULTICAST_ADDRESS = '239.255.68.71';
const PORT = 20114;
const DEFAULT_CHANNEL = 6;
const MAX_PACKET_BYTES = 8192;
const MAX_MESSAGE_LENGTH = 128;
const MAX_VALUE_LENGTH = 1024;
const ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;

const isChannel = channel => Number.isInteger(channel) && channel >= 1 && channel <= 16;
const isMessage = message => typeof message === 'string' && message.trim().length > 0 &&
    Array.from(message).length <= MAX_MESSAGE_LENGTH;
const isValue = value => typeof value === 'string' && Array.from(value).length <= MAX_VALUE_LENGTH;

const isPacket = packet => Boolean(packet && !Array.isArray(packet) && packet.protocol === PROTOCOL &&
    packet.version === VERSION && typeof packet.sender === 'string' && ID_PATTERN.test(packet.sender) &&
    typeof packet.id === 'string' && ID_PATTERN.test(packet.id) && isChannel(packet.channel) &&
    isMessage(packet.message) && isValue(packet.value));

const decodePacket = bytes => {
    if (bytes.length > MAX_PACKET_BYTES) return null;
    try {
        const packet = JSON.parse(bytes.toString('utf8'));
        return isPacket(packet) ? packet : null;
    } catch (error) {
        return null;
    }
};

module.exports = {
    PROTOCOL,
    VERSION,
    MULTICAST_ADDRESS,
    PORT,
    DEFAULT_CHANNEL,
    MAX_PACKET_BYTES,
    isChannel,
    isMessage,
    isValue,
    isPacket,
    decodePacket
};
