#!/bin/bash
# 启动菜单栏应用：绕过可能存在的 ELECTRON_RUN_AS_NODE=1 环境干扰
cd "$(dirname "$0")/.."
BIN="node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
[ -x "$BIN" ] || BIN="node_modules/.bin/electron"
env -u ELECTRON_RUN_AS_NODE "$BIN" electron/main.cjs
