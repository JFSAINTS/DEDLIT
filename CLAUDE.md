# DEDLIT Studio — guía para desarrollo

Frontend local y privado de IA. **Cero dependencias en runtime** (solo Node ≥ 18); esta restricción es deliberada y debe mantenerse — no añadir paquetes npm al servidor ni frameworks/CDNs al cliente sin una razón muy fuerte.

## Arquitectura

- `server.js` — servidor HTTP (solo escucha en 127.0.0.1). Rutas: `/api/*` (config, modelos, chat SSE, aprobaciones, upload, generación multimedia, VS Code), `/v1/*` (gateway OpenAI-compatible para Continue/Cline, modelo = `proveedor:modelo`), `/media/*` (archivos), estáticos desde `public/`.
- `lib/providers.js` — registro de proveedores y adaptadores de streaming. Todo usa el formato de mensajes estilo OpenAI internamente; Anthropic tiene su propio adaptador con conversión de mensajes/herramientas/imágenes. Para añadir un proveedor OpenAI-compatible basta una entrada en `REGISTRY`.
- `lib/agent.js` — herramientas del modo agente (list_directory, read_file, search_files, write_file, run_command, fetch_url, open_in_browser) con categorías read/write/command/network que controlan si se pide aprobación al usuario.
- `lib/mcp.js` — cliente MCP por stdio (JSON-RPC por líneas, sin dependencias). Config en `config.mcpServers` (formato Claude Desktop). Las herramientas de conectores se exponen como `mcp__servidor__herramienta`; readOnlyHint del conector → categoría read, si no command. `sync()` es idempotente y se llama al empezar cada chat en modo agente.
- `lib/config.js` — configuración en `%USERPROFILE%\.dedlit\`; API keys cifradas con AES-256-GCM (clave en `secret.key`).
- `lib/media.js` — almacén de medios en `~/.dedlit/media`. El historial guarda referencias `media:archivo`; se resuelven a data-URIs/base64 justo antes de llamar al proveedor (`resolveMessages`). Los mensajes con `generated: true` se reducen a texto al reenviarse.
- `public/` — cliente en HTML/CSS/JS puro. `app.js` mantiene los chats en localStorage (solo referencias a medios, nunca binarios). El renderizador Markdown es propio; los bloques de código usan marcadores `\uE000N\uE001`.

## Flujo del modo agente

`POST /api/chat` responde SSE con eventos `text`, `tool_call`, `approval_request`, `tool_result`, `error`, `done`. Cuando una herramienta requiere aprobación, el servidor queda a la espera de `POST /api/approval` (mapa `pendingApprovals`, timeout 10 min). Al terminar, el evento `done` incluye los mensajes canónicos del turno para que el cliente los añada a su historial.

## Desarrollo y build

```powershell
node server.js            # http://127.0.0.1:8642 (puerto: DEDLIT_PORT)
npm run build:exe         # dist/dedlit-studio.exe (@yao-pkg/pkg, node22-win-x64)
npm run build:macos       # binarios macOS x64+arm64 (--no-bytecode, requerido en cross-build;
                          #  firmar en un Mac con: codesign --sign - <binario>)
```

Sin tests automatizados por ahora; para probar sin proveedor real, hay un patrón útil: montar un mock OpenAI-compatible en localhost y apuntar la URL base de la ranura "lmstudio" hacia él desde Ajustes o `POST /api/config`.

## Principios

- Privacidad primero: nada de telemetría, nada de peticiones a terceros salvo a los proveedores configurados por el usuario, escuchar solo en localhost.
- Los textos de la interfaz están en español.
- Acciones del agente destructivas o de escritura piden aprobación por defecto; no cambiar los valores por defecto de `autoApprove`.
