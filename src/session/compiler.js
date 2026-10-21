const fs = require('fs');
const os = require('os');
const path = require('path');

const Session = require('./session');
const Arduino = require('../upload/arduino');

/**
 * Boards accepted by the local compiler. Keep in sync with
 * openblock-api/src/compiler/arduino-boards.ts so offline and online builds match.
 * @readonly
 */
const ARDUINO_BOARD_FQBNS = {
    arduinoUno: 'arduino:avr:uno',
    arduinoNano: 'arduino:avr:nano:cpu=atmega328old',
    arduinoLeonardo: 'arduino:avr:leonardo'
};

const MAX_CODE_LENGTH = 512 * 1024;

/**
 * Web origins allowed to request local builds. The compiled artifact is returned
 * to the caller, so arbitrary sites must not be able to use this route.
 * Override with a comma separated list in OPENBLOCK_LINK_COMPILER_ORIGINS.
 * @readonly
 */
const DEFAULT_ALLOWED_ORIGINS = [
    'https://dogoblock.vercel.app',
    'https://dogomaker.com',
    'https://*.dogomaker.com',
    'http://localhost:*',
    'http://127.0.0.1:*'
];

const getAllowedOrigins = () => {
    const configured = process.env.OPENBLOCK_LINK_COMPILER_ORIGINS;
    if (!configured) return DEFAULT_ALLOWED_ORIGINS;
    return configured.split(',').map(item => item.trim())
        .filter(Boolean);
};

const matchesOriginPattern = (origin, pattern) => {
    let originUrl;
    try {
        originUrl = new URL(origin);
    } catch (err) {
        return false;
    }
    const match = /^(https?):\/\/(\*\.)?([^:/*]+)(?::(\d+|\*))?$/.exec(pattern);
    if (!match) return false;
    const [, protocol, wildcard, host, port] = match;
    if (originUrl.protocol !== `${protocol}:`) return false;
    if (wildcard ? !originUrl.hostname.endsWith(`.${host}`) : originUrl.hostname !== host) return false;
    return port === '*' || originUrl.port === (port || '');
};

const isLoopbackAddress = address => address === '::1' || /^(::ffff:)?127\./.test(address || '');

// arduino-cli shares build folders per board, so builds run one at a time.
let compileQueue = Promise.resolve();
const enqueueCompile = task => {
    const run = compileQueue.then(task, task);
    compileQueue = run.catch(() => {});
    return run;
};

// Creating an uploader initializes arduino-cli, which is slow; reuse it between requests.
const arduinoTools = new Map();
let compileStdout = null;

class CompilerSession extends Session {
    /**
     * Check whether a connection may use the local compiler.
     * @param {http.IncomingMessage} request - the websocket upgrade request.
     * @returns {?string} the rejection reason, or null when allowed.
     */
    static verifyRequest (request) {
        if (!isLoopbackAddress(request.socket.remoteAddress)) {
            return `remote address ${request.socket.remoteAddress} is not local`;
        }
        const origin = request.headers.origin;
        if (!origin || !getAllowedOrigins().some(pattern => matchesOriginPattern(origin, pattern))) {
            return `origin ${origin || '(none)'} is not allowed`;
        }
        return null;
    }

    constructor (socket, userDataPath, toolsPath) {
        super(socket);

        this.userDataPath = path.join(userDataPath, 'compiler');
        this.toolsPath = toolsPath;
        this._type = 'compiler';
    }

    async didReceiveCall (method, params, completion) {
        switch (method) {
        case 'compile':
            try {
                completion(await this.compile(params), null);
            } catch (err) {
                completion(null, {message: err.message});
            }
            break;
        default:
            completion(null, {message: `Method not found: ${method}`});
        }
    }

    compile (params) {
        const {board, code} = params;
        const fqbn = ARDUINO_BOARD_FQBNS[board];
        if (!fqbn) {
            return Promise.reject(new Error(`Compilacao local nao suporta a placa ${board}.`));
        }
        if (typeof code !== 'string' || !code.trim()) {
            return Promise.reject(new Error('Codigo Arduino vazio.'));
        }
        if (code.length > MAX_CODE_LENGTH) {
            return Promise.reject(new Error('Codigo Arduino muito grande para compilar.'));
        }
        const arduinoCli = path.join(this.toolsPath, 'Arduino',
            os.platform() === 'win32' ? 'arduino-cli.exe' : 'arduino-cli');
        if (!fs.existsSync(arduinoCli)) {
            return Promise.reject(new Error(
                'Este DoGoBlock Agent nao inclui o compilador Arduino offline. Instale a versao Offline do Agent.'
            ));
        }

        return enqueueCompile(async () => {
            compileStdout = message => this.sendstd(message);
            const key = `${this.toolsPath}|${fqbn}`;
            if (!arduinoTools.has(key)) {
                arduinoTools.set(key, new Arduino(null, {fqbn, library: []}, this.userDataPath, this.toolsPath,
                    message => compileStdout && compileStdout(message)));
            }
            const tool = arduinoTools.get(key);
            try {
                const hexPath = tool.getBuildHexPath();
                fs.rmSync(hexPath, {force: true});
                await tool.build(code);
                return {board, fqbn, hex: fs.readFileSync(hexPath, 'utf8')};
            } catch (err) {
                arduinoTools.delete(key);
                throw err;
            } finally {
                compileStdout = null;
            }
        });
    }

    sendstd (message) {
        if (this._socket) {
            this.sendRemoteRequest('compileStdout', {message});
        }
    }
}

CompilerSession.matchesOriginPattern = matchesOriginPattern;

module.exports = CompilerSession;
