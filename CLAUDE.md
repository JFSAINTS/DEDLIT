# DEDLIT Studio — guía para desarrollo

Frontend local y privado de IA. **Cero dependencias en runtime** (solo Node ≥ 18); esta restricción es deliberada y debe mantenerse — no añadir paquetes npm al servidor ni frameworks/CDNs al cliente sin una razón muy fuerte.

## Arquitectura

- `server.js` — servidor HTTP (solo escucha en 127.0.0.1). Rutas: `/api/*` (config, modelos, chat SSE, aprobaciones, upload, generación multimedia, VS Code), `/v1/*` (gateway OpenAI-compatible para Continue/Cline, modelo = `proveedor:modelo`), `/media/*` (archivos), estáticos desde `public/`.
- `lib/providers.js` — registro de proveedores y adaptadores de streaming. Todo usa el formato de mensajes estilo OpenAI internamente; Anthropic tiene su propio adaptador con conversión de mensajes/herramientas/imágenes. Para añadir un proveedor OpenAI-compatible basta una entrada en `REGISTRY`.
- `lib/agent.js` — herramientas del modo agente (list_directory, read_file, search_files, write_file, run_command, fetch_url, open_in_browser) con categorías read/write/command/network que controlan si se pide aprobación al usuario.
- `lib/mcp.js` — cliente MCP por stdio (JSON-RPC por líneas, sin dependencias). Config en `config.mcpServers` (formato Claude Desktop). Las herramientas de conectores se exponen como `mcp__servidor__herramienta`; readOnlyHint del conector → categoría read, si no command. `sync()` es idempotente. También define MANAGEMENT_TOOLS (`add_mcp_connector`, `list_mcp_connectors`) con las que el agente se amplía a sí mismo.
- Autoextensión: la lista de herramientas se recalcula en **cada iteración** del bucle del agente (server.js), para que un conector recién añadido aporte herramientas en la misma conversación. `show_media`/`generate_image` devuelven el marcador `SHOWMEDIA::{json}`; el servidor lo detecta, emite el evento SSE `media` al chat y sustituye el resultado por texto neutro antes de reenviarlo al modelo. `generate_image` y las herramientas de gestión MCP se ejecutan en server.js (necesitan cfg), el resto en agent.js.
- `lib/config.js` — configuración en `%USERPROFILE%\.dedlit\`; API keys cifradas con AES-256-GCM (clave en `secret.key`).
- `lib/chats.js` — historial de conversaciones en disco (`~/.dedlit/chats`, un JSON por chat), con búsqueda de texto y exportación a Markdown. Rutas `/api/chats*`. El cliente migra automáticamente los chats antiguos de localStorage la primera vez.
- Imágenes: `pickImageBackend` en server.js decide el backend — prioridad Stable Diffusion local (`sdCheck`/`sdGenerate`, API Automatic1111, `config.sdWebuiUrl`) → ComfyUI (`comfyCheck`/`comfyGenerate`, workflow txt2img por API, `config.comfyUrl`) → nube (OpenAI/xAI/Zhipu). `config.customInstructions` se añade al system solo en la copia enviada al proveedor (nunca al historial).
- `lib/rag.js` — RAG local: extracción de texto (texto/código, PDF con extractor mínimo de streams Flate+Tj, DOCX descomprimiendo el ZIP a mano), troceado con solape, embeddings vía `providers.embed` (/v1/embeddings de cualquier proveedor openai-kind), coseno en JS. Colecciones en `~/.dedlit/rag`. En el chat, `body.ragId` inyecta los 5 fragmentos más afines como system; el agente tiene `search_docs` (se ejecuta en server.js).
- Voz: `config.sttUrl`/`config.ttsUrl` (servidores locales OpenAI-compatibles) tienen prioridad sobre el proveedor en `/api/transcribe` y `/api/generate/speech`.
- `lib/updater.js` — auto-actualización desde GitHub Releases (`/api/update/check` e `/install`). En Windows el reemplazo lo hace un .ps1 lanzado **vía WMI** (Win32_Process.Create): imprescindible, porque un hijo normal muere con el padre en según qué contextos (Job Objects) y cmd/timeout fallan sin consola. El proceso WMI no hereda el entorno → el script fija DEDLIT_PORT explícitamente. Token opcional cifrado en `keys.ghupdate` para repos privados (el repo es público actualmente).
- `lib/media.js` — almacén de medios en `~/.dedlit/media`. El historial guarda referencias `media:archivo`; se resuelven a data-URIs/base64 justo antes de llamar al proveedor (`resolveMessages`). Los mensajes con `generated: true` se reducen a texto al reenviarse.
- `lib/system.js` — detección de hardware (RAM; VRAM vía nvidia-smi → registro de Windows → memoria unificada en macOS arm64) y `verdict()` (semáforo 🟢🟡🔴 para GGUF: necesita ≈ tamaño×1.15 + 1.5 GB). Rutas `/api/system` y `/api/hub/*` (búsqueda HF, archivos con multiparte agrupado, descarga SSE a LM Studio u `ollama pull hf.co/...`).
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

- Privacidad primero: nada de telemetría, nada de peticiones a terceros salvo a los proveedores configurados por el usuario, escuchar solo en localhost (salvo acceso LAN opt-in con contraseña: `lanHost`/`lanPasswordHash` en config, sesiones por cookie para peticiones no-loopback, Bearer para /v1; `applyListen` re-escucha sin reiniciar y debe llamarse aplazado tras responder).
- Los textos de la interfaz están en español (idioma nativo); el inglés se aplica traduciendo el DOM con el diccionario de `public/i18n.js` — al añadir texto nuevo a la interfaz, añadir su entrada al diccionario.
- Acciones del agente destructivas o de escritura piden aprobación por defecto; no cambiar los valores por defecto de `autoApprove`.
