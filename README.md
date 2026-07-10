# ◆ DEDLIT Studio

Frontend **local y privado** para trabajar con modelos de IA — locales y en la nube — con modo agente estilo Claude Code / OpenClaw: el modelo puede inspeccionar tu equipo, leer y escribir archivos, instalar paquetes y trabajar con git/GitHub, siempre **con tu aprobación**.

**Cero dependencias externas**: solo Node.js ≥ 18. Sin frameworks, sin CDNs, sin telemetría. El servidor escucha únicamente en `127.0.0.1`.

## Arranque

**Opción A — ejecutable** (no requiere Node): descarga el binario de tu plataforma desde [Releases](https://github.com/JFSAINTS/DEDLIT/releases):

- **Windows**: `dedlit-studio-win-x64.exe` — doble clic y listo.
- **macOS (Apple Silicon)**: `DEDLIT-Studio-arm64.dmg` — abre el DMG, arrastra **DEDLIT Studio** a Aplicaciones y lánzala (arranca el servidor y abre el navegador; para pararlo, sal de la app desde el Dock). La primera vez, si Gatekeeper se queja: clic derecho → *Abrir*, o `xattr -dr com.apple.quarantine "/Applications/DEDLIT Studio.app"`.
- **Linux**: `dedlit-studio-linux-x64` — `chmod +x` y ejecutar.
- **macOS (binario suelto)**: `dedlit-studio-macos-arm64` (Apple Silicon) o `dedlit-studio-macos-x64` (Intel), para lanzarlo desde Terminal:

  ```bash
  chmod +x dedlit-studio-macos-arm64
  xattr -d com.apple.quarantine dedlit-studio-macos-arm64   # quitar cuarentena de Gatekeeper
  ./dedlit-studio-macos-arm64
  ```

**Opción B — desde el código** (requiere Node ≥ 18):

```powershell
node server.js
# o: npm start
```

Abre **http://127.0.0.1:8642** en el navegador. Puerto configurable con la variable de entorno `DEDLIT_PORT`.

## Proveedores soportados

| Proveedor | Grupo | Endpoint por defecto |
|---|---|---|
| Ollama | local | `http://127.0.0.1:11434/v1` |
| LM Studio | local | `http://127.0.0.1:1234/v1` |
| Google (Gemini) | nivel gratuito | endpoint OpenAI-compatible de Google |
| OpenRouter | nivel gratuito | `openrouter.ai` (modelos `:free`) |
| Groq | nivel gratuito | `api.groq.com` |
| Mistral | nivel gratuito | `api.mistral.ai` |
| Cerebras | nivel gratuito | `api.cerebras.ai` |
| GitHub Models | nivel gratuito | `models.github.ai` (key = token PAT de GitHub) |
| NVIDIA NIM | nivel gratuito | `integrate.api.nvidia.com` |
| Hugging Face | nivel gratuito | `router.huggingface.co` |
| Anthropic (Claude) | de pago | API nativa de Anthropic |
| OpenAI | de pago | `api.openai.com` |
| xAI (Grok) | de pago | `api.x.ai` — requiere API key de xAI* |
| DeepSeek | de pago | `api.deepseek.com` |
| Alibaba Qwen | de pago | DashScope (modo compatible) |
| Moonshot (Kimi) | de pago | `api.moonshot.ai` |
| Zhipu (GLM) | de pago | `open.bigmodel.cn` |

\* Grok vía suscripción X Premium no expone API pública; necesitas una API key de [console.x.ai](https://console.x.ai) (aunque OpenRouter y GitHub Models ofrecen modelos Grok en sus niveles gratuitos). Las URLs base son editables en Ajustes, así que puedes añadir cualquier endpoint OpenAI-compatible (vLLM, llama.cpp server, LiteLLM, etc.) reutilizando cualquiera de las ranuras.

Los servidores locales (Ollama / LM Studio) se detectan automáticamente y su estado se muestra en la barra lateral. En LM Studio activa el servidor local (pestaña *Developer* → *Start Server*).

## Buscador de modelos con semáforo (🧲)

El botón **🧲 Modelos** abre un buscador de **Hugging Face** integrado (modelos GGUF, los que usan LM Studio y Ollama). DEDLIT detecta tu hardware —RAM y VRAM de la GPU (nvidia-smi o registro de Windows; memoria unificada en Apple Silicon)— y muestra un **semáforo por cada cuantización**:

- 🟢 cabe entero en la GPU (rápido)
- 🟡 carga parcial GPU+CPU, o solo CPU (funciona, más lento)
- 🔴 no cabe en la memoria del equipo

Los GGUF multiparte se evalúan por su **tamaño total**, no por archivo. Cada cuantización tiene descarga directa: **⬇ LM Studio** (a la carpeta de modelos, configurable en Ajustes, con estructura `editor/modelo/` que LM Studio indexa solo) u **⬇ Ollama** (`ollama pull hf.co/repo:CUANT`, que gestiona también los multiparte). La búsqueda consulta huggingface.co únicamente cuando tú la lanzas.

## Chatear con tus documentos (📚 RAG local)

Con el botón **🛠** de la sección *📚 Documentos* indexas cualquier carpeta: texto, código, Markdown, **PDF** y **DOCX** (extractores propios, sin dependencias). Los embeddings se calculan con el proveedor que elijas — recomendado **local** (LM Studio u Ollama con un modelo como `nomic-embed-text`), de modo que tus documentos nunca salen de tu equipo. El índice vive en `~/.dedlit/rag`.

Después, elige la colección en el selector de la barra lateral y el modelo responderá usando los fragmentos más afines como contexto, **citando el archivo**. El agente además tiene la herramienta `search_docs` para consultar tus colecciones cuando lo necesite.

## Voz local (opcional)

En Ajustes puedes configurar servidores locales OpenAI-compatibles para **📝 transcripción** (whisper.cpp `server`, faster-whisper-server) y **🔊 texto a voz** (kokoro-fastapi, openedai-speech). Si están configurados tienen prioridad sobre la nube: voz completamente privada y gratuita.

## ¿Sin API key? — APIs gratuitas

El botón **🎁 APIs gratis** de la barra lateral resume los servicios con nivel gratuito (basado en [cheahjs/free-llm-api-resources](https://github.com/cheahjs/free-llm-api-resources)): qué ofrece cada uno, enlace directo para crear la key y acceso rápido a Ajustes para pegarla. Todos vienen preconfigurados como proveedores, sin tocar URLs.

> Aviso: los límites gratuitos cambian a menudo y algunos servicios pueden usar tus conversaciones para entrenar modelos. Para privacidad total, usa Ollama o LM Studio en local.

## API keys y privacidad

- Las keys se guardan **cifradas con AES-256-GCM** en `%USERPROFILE%\.dedlit\config.json` (la clave de cifrado en `secret.key`, misma carpeta). Nunca se envían al navegador ni a ningún sitio salvo al proveedor correspondiente.
- Las conversaciones se guardan **en tu disco** (`%USERPROFILE%\.dedlit\chats`) — se comparten entre navegadores, sobreviven a limpiezas y nunca salen de tu equipo. Puedes **buscar** en todo el historial desde la barra lateral y **exportar** cualquier chat a Markdown o JSON desde la barra superior, donde también puedes **↻ regenerar** la última respuesta.
- En Ajustes puedes definir **instrucciones personalizadas** (p. ej. "responde siempre en español, sé conciso") que se aplican a todas tus conversaciones.
- Cada chat **recuerda su configuración** (proveedor, modelo, modo agente y colección RAG): al reabrirlo se restaura todo.
- **📋 Plantillas de prompts** reutilizables con huecos `{{campo}}` que se rellenan al usarlas.
- **Atajos**: `Ctrl+K` buscar en el historial, `Ctrl+Shift+O` nuevo chat, `Ctrl+,` ajustes, `Alt+A` modo agente, `Esc` cerrar ventanas.
- **Tema claro/oscuro** con el botón 🌗 de la barra lateral (se recuerda tu elección).
- **📁 Proyectos**: agrupa conversaciones con sus propias instrucciones y colección de documentos por defecto; el selector filtra la lista y los chats nuevos nacen dentro del proyecto activo.
- **Interfaz en español o inglés** (selector en Ajustes).
- **Auto-actualización**: al abrir comprueba si hay versión nueva en las releases de GitHub (desactivable en Ajustes) y, previo aviso con un banner, descarga el binario, se reemplaza a sí mismo y se reinicia solo. Desde código fuente o desde la app de macOS, el banner enlaza a la descarga manual.
- Con modelos locales (Ollama / LM Studio), **ningún dato sale de tu máquina**.

## Modo agente

Activa el interruptor **Modo agente** en la barra lateral. El modelo obtiene herramientas para:

- `list_directory` / `read_file` / `search_files` — inspeccionar y buscar en el workspace (aprobación automática por defecto)
- `write_file` — crear o modificar archivos (**requiere tu aprobación** por defecto)
- `run_command` — terminal (PowerShell en Windows, bash en macOS/Linux): instalar paquetes, ejecutar tests, `git`, `gh` para GitHub… (**requiere tu aprobación** por defecto)
- `fetch_url` — leer páginas web o APIs como texto (**requiere tu aprobación** por defecto)
- `open_in_browser` — abrir una URL en tu navegador por defecto (**requiere tu aprobación** por defecto)
- `generate_image` — generar una imagen con tu proveedor de imágenes configurado y mostrarla en el chat
- `show_media` — mostrar en el chat cualquier archivo local de imagen/audio/vídeo que produzca
- `add_mcp_connector` / `list_mcp_connectors` — **ampliarse a sí mismo**: añadir conectores MCP en mitad de la conversación y usar sus herramientas al instante (**requiere tu aprobación**)

El agente está orientado a objetivos: si le falta una capacidad para completar lo que pides (generar un vídeo, controlar el navegador…), buscará la forma — instalar una herramienta, leer documentación o añadir el conector adecuado — y te devolverá el resultado en el chat.

Cada acción aparece como una tarjeta en el chat con los argumentos exactos; tú decides **Aprobar** o **Rechazar**. Las políticas de aprobación automática y el workspace raíz se cambian en ⚙ Ajustes.

## Conectores (MCP)

DEDLIT es **cliente de Model Context Protocol**, el estándar de conectores de Claude Desktop / Claude Code, con el mismo formato de configuración. En ⚙ Ajustes → *Conectores (MCP)* pega, por ejemplo:

```json
{
  "navegador": { "command": "npx", "args": ["-y", "@playwright/mcp@latest"] },
  "canva": { "command": "npx", "args": ["-y", "mcp-remote", "https://mcp.canva.com/mcp"] },
  "github": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"],
              "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "ghp_..." } }
}
```

Con el conector `navegador` el agente puede **controlar Chrome/Edge de verdad**: navegar, hacer clic, rellenar formularios, sacar capturas… Las herramientas de cada conector aparecen en el chat con el prefijo `mcp__nombre__` y piden aprobación como cualquier comando (salvo las marcadas de solo lectura por el propio conector). Hay cientos de conectores MCP publicados — cualquier servidor MCP por stdio sirve.

Los **servidores MCP remotos** (Canva, y cualquier otro `https://…/mcp` con OAuth) funcionan a través del puente `mcp-remote`, como en el ejemplo: la primera vez se abre el navegador para autorizar tu cuenta y el token queda guardado localmente. Con el conector de Canva el agente puede crear diseños, rellenar plantillas y exportarlos desde el chat.

> Nota: los modelos locales necesitan soporte de *function calling* para el modo agente (p. ej. `qwen2.5`, `llama3.1`, `mistral-nemo` en Ollama; en LM Studio, modelos con plantilla de herramientas).

## Multimedia: imágenes, audio y vídeo

Según las capacidades del modelo cargado (se muestran como chips bajo el selector, estimadas por el nombre):

**Entrada (adjuntos)** — botón 📎, pegar desde el portapapeles o arrastrar y soltar:

- **Imágenes** → modelos con visión (gpt-4o/4.1/5, Claude, Gemini, Grok-2+, `llava`/`qwen-vl`/`minicpm-v` en Ollama…). Con Anthropic se convierten al formato nativo; audio/vídeo se sustituyen por una nota porque Claude no los admite.
- **Audio** → modelos con entrada de audio (gpt-4o-audio, Gemini, Qwen-Omni…), en formato `input_audio` OpenAI.
- **Vídeo** → modelos que lo soporten vía `video_url` (Gemini, Qwen-Omni/VL-Max…).

**Generación** — selector de modo junto al campo de texto:

- 🖼️ **Generar imagen**: si tienes **Stable Diffusion local** (Automatic1111/SD.Next/Forge arrancado con `--api`; URL en Ajustes) se usa automáticamente — gratis y 100% privado. Si no, `gpt-image-1`/`dall-e-3` (OpenAI), `grok-2-image` (xAI) o `cogview-4` (Zhipu) con key.
- 🔊 **Generar voz (TTS)**: `tts-1`, `gpt-4o-mini-tts`… (campo de voz configurable: alloy, echo, nova…).
- 📝 **Transcribir audio**: adjunta un audio y usa `whisper-1` / `gpt-4o-transcribe`.

Todos los archivos (adjuntos y generados) se guardan **en tu disco** en `%USERPROFILE%\.dedlit\media\`; el historial solo guarda referencias ligeras, y nada se sube a ningún sitio salvo al proveedor del modelo que tú elijas.

## Integración con VS Code

1. **Abrir el workspace**: botón *⌨ VS Code* en la barra lateral.
2. **Usar DEDLIT como pasarela de modelos** para extensiones como [Continue](https://continue.dev) o Cline: apunta la extensión al endpoint OpenAI-compatible

   ```
   http://127.0.0.1:8642/v1
   ```

   con el modelo en formato `proveedor:modelo`, por ejemplo `ollama:llama3.1`, `lmstudio:qwen2.5-coder-14b` o `anthropic:claude-sonnet-5`. Así configuras las keys una sola vez aquí y todas tus herramientas las reutilizan.

   Ejemplo para Continue (`config.yaml`):

   ```yaml
   models:
     - name: DEDLIT gateway
       provider: openai
       apiBase: http://127.0.0.1:8642/v1
       apiKey: local
       model: ollama:llama3.1
   ```

## Estructura

```
server.js          Servidor HTTP + bucle de agente + gateway /v1
lib/config.js      Configuración y cifrado de keys
lib/providers.js   Adaptadores (OpenAI-compatible y Anthropic nativo)
lib/agent.js       Herramientas del agente y prompt de sistema
lib/media.js       Almacén local de imágenes/audio/vídeo
public/            Interfaz web (HTML/CSS/JS puro)
```

## Compilar los ejecutables

```powershell
npm install            # solo instala la herramienta de build (@yao-pkg/pkg)
npm run build:exe      # Windows x64  → dist/dedlit-studio.exe
npm run build:macos    # macOS x64 + arm64 (sin bytecode, necesario para compilar en cruzado)
npm run build:all      # todo
```

El runtime sigue siendo cero-dependencias; `@yao-pkg/pkg` es solo `devDependency`. En CI, cada push a `main` compila los binarios como artefactos (los de macOS en un runner de macOS, que los firma ad-hoc — imprescindible en Apple Silicon), y las etiquetas `v*` los publican en Releases. Si compilas el binario de macOS desde Windows/Linux, fírmalo después en un Mac con `codesign --sign - <binario>`.

## Hoja de ruta

- [x] Historial de chats en disco (`~/.dedlit/chats`, con migración automática desde localStorage — v0.6.0)
- [x] Búsqueda en conversaciones y exportación Markdown/JSON (v0.6.0)
- [x] Herramienta de búsqueda de archivos para el agente (`search_files`, v0.3.0)
- [x] Soporte de herramientas (function calling) en el gateway /v1 (v0.6.0)
- [x] MCP (Model Context Protocol) como fuente de herramientas del agente (v0.3.0, autoextensible desde v0.4.0)
- [x] Generación de imágenes con Stable Diffusion local (Automatic1111/SD.Next/Forge — v0.6.0)
- [x] Empaquetado para Linux (v0.6.0)
- [x] Voz local: endpoints OpenAI-compatibles configurables para STT (whisper.cpp server, faster-whisper) y TTS (kokoro, openedai-speech) con prioridad sobre la nube (v0.7.0)
- [x] RAG local: chatear con tus documentos — carpetas, PDF y DOCX (v0.7.0)
- [x] Editar mensajes anteriores del usuario (v0.7.0)
- [x] ComfyUI como backend adicional de imágenes (v0.7.0)

Las contribuciones son bienvenidas. Lee `CLAUDE.md` para entender la arquitectura y los principios del proyecto (privacidad primero, cero dependencias en runtime).
