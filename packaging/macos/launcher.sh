#!/bin/bash
# Lanzador de DEDLIT.app: arranca el servidor (si no lo está ya) y abre el
# navegador. Al salir de la app (Dock → Salir) se detiene el servidor.
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN="$DIR/dedlit-studio"
PORT="${DEDLIT_PORT:-8642}"
URL="http://127.0.0.1:$PORT"

alive() { curl -s -o /dev/null --max-time 1 "$URL/api/config"; }

if alive; then
  open "$URL"
  exit 0
fi

"$BIN" &
SERVER_PID=$!
trap 'kill "$SERVER_PID" 2>/dev/null' EXIT TERM INT

for _ in $(seq 1 60); do
  alive && break
  kill -0 "$SERVER_PID" 2>/dev/null || exit 1
  sleep 0.25
done

open "$URL"
wait "$SERVER_PID"
