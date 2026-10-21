# openblock-link
[![Publish Npm Package](https://github.com/openblockcc/openblock-link/actions/workflows/publish-npm-package.yml/badge.svg)](https://github.com/openblockcc/openblock-link/actions/workflows/publish-npm-package.yml)
![](https://img.shields.io/github/license/openblockcc/openblock-link)

### Instructions
```bash
npm install
npm run fetch
npm start
```

If you work on windows and want to use BLE connection check this instructions: [https://github.com/noble/noble](https://github.com/noble/noble)

### Local Arduino compiler route

`ws://127.0.0.1:20111/openblock/compiler` compiles Arduino sketches with the
`arduino-cli` found in `<toolsPath>/Arduino` and returns the `.hex`. It is used
by DoGoBlock Agent Offline so the web editor can program boards without
Dogoblock API.

- Request: `{"jsonrpc": "2.0", "id": 1, "method": "compile", "params": {"board": "arduinoUno", "code": "..."}}`.
  Boards: `arduinoUno`, `arduinoNano`, `arduinoLeonardo` (same FQBNs as
  `openblock-api/src/compiler/arduino-boards.ts`).
- Compiler output arrives as `compileStdout` notifications; the response result is
  `{board, fqbn, hex}`.
- Only connections from the local machine and from allowed web origins are
  accepted (`https://dogoblock.vercel.app`, `https://*.dogomaker.com` and
  `localhost` by default). Set `OPENBLOCK_LINK_COMPILER_ORIGINS` to a comma
  separated list to override them.

`npm test` covers the route without compiling. To also build a sketch with the
toolchain in `./tools` (after `npm run fetch`):

```bash
OPENBLOCK_LINK_COMPILER_TEST=1 node test/compiler-session.test.js
```
