'use strict';
// DEDLIT Studio — servidor local. Sin dependencias externas: solo Node >= 18.
// Escucha únicamente en 127.0.0.1 para que nada sea accesible desde la red.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const configLib = require('./lib/config');
const providers = require('./lib/providers');
const agent = require('./lib/agent');
const media = require('./lib/media');
const mcp = require('./lib/mcp');
const system = require('./lib/system');
const chats = require('./lib/chats');
const rag = require('./lib/rag');

const PORT = Number(process.env.DEDLIT_PORT || 8642);
const PUBLIC = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

// Aprobaciones pendientes del modo agente: id -> resolve(bool)
const pendingApprovals = new Map();

// ---------- Utilidades HTTP ----------

function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(body);
}

function readBody(req, maxBytes = 20 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => {
      data += c;
      if (data.length > maxBytes) { reject(new Error('Body demasiado grande')); req.destroy(); }
    });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function sseStart(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });
}

function sse(res, obj) {
  res.write('data: ' + JSON.stringify(obj) + '\n\n');
}

// ---------- Rutas API ----------

async function handleApi(req, res, url) {
  const cfg = configLib.load();

  // Config (keys enmascaradas: solo se informa si están configuradas)
  if (url.pathname === '/api/config' && req.method === 'GET') {
    const provs = {};
    for (const [id, p] of Object.entries(providers.REGISTRY)) {
      provs[id] = {
        name: p.name, needsKey: p.needsKey, local: !!p.local,
        group: p.group || 'paid', keyUrl: p.keyUrl || '',
        hasKey: !!cfg.keys[id],
        baseUrl: cfg.baseUrls[id] || p.base
      };
    }
    return json(res, 200, {
      providers: provs,
      workspace: cfg.workspace,
      autoApprove: cfg.autoApprove,
      mcpServers: cfg.mcpServers,
      lmstudioModelsDir: cfg.lmstudioModelsDir || '',
      lmstudioModelsDirDefault: path.join(require('os').homedir(), '.lmstudio', 'models'),
      sdWebuiUrl: cfg.sdWebuiUrl || 'http://127.0.0.1:7860',
      comfyUrl: cfg.comfyUrl || 'http://127.0.0.1:8188',
      sttUrl: cfg.sttUrl || '',
      ttsUrl: cfg.ttsUrl || '',
      customInstructions: cfg.customInstructions || '',
      promptTemplates: cfg.promptTemplates || [],
      temperature: cfg.temperature,
      lastProvider: cfg.lastProvider,
      lastModel: cfg.lastModel,
      gatewayUrl: `http://127.0.0.1:${PORT}/v1`
    });
  }

  if (url.pathname === '/api/config' && req.method === 'POST') {
    const body = await readBody(req);
    if (typeof body.workspace === 'string' && body.workspace.trim()) cfg.workspace = body.workspace.trim();
    if (body.autoApprove) cfg.autoApprove = { ...cfg.autoApprove, ...body.autoApprove };
    if (typeof body.temperature === 'number') cfg.temperature = body.temperature;
    if (typeof body.lastProvider === 'string') cfg.lastProvider = body.lastProvider;
    if (typeof body.lastModel === 'string') cfg.lastModel = body.lastModel;
    if (body.keys) {
      for (const [id, val] of Object.entries(body.keys)) {
        if (val === null) continue;                 // null = no cambiar
        configLib.setKey(cfg, id, String(val));     // '' = borrar
      }
    }
    if (body.baseUrls) {
      for (const [id, val] of Object.entries(body.baseUrls)) {
        if (val === null) continue;
        if (val && val !== providers.REGISTRY[id]?.base) cfg.baseUrls[id] = val;
        else delete cfg.baseUrls[id];
      }
    }
    if (body.mcpServers && typeof body.mcpServers === 'object') {
      cfg.mcpServers = body.mcpServers;
    }
    if (typeof body.lmstudioModelsDir === 'string') cfg.lmstudioModelsDir = body.lmstudioModelsDir.trim();
    if (typeof body.sdWebuiUrl === 'string') cfg.sdWebuiUrl = body.sdWebuiUrl.trim() || 'http://127.0.0.1:7860';
    if (typeof body.comfyUrl === 'string') cfg.comfyUrl = body.comfyUrl.trim() || 'http://127.0.0.1:8188';
    if (typeof body.sttUrl === 'string') cfg.sttUrl = body.sttUrl.trim();
    if (typeof body.ttsUrl === 'string') cfg.ttsUrl = body.ttsUrl.trim();
    if (typeof body.customInstructions === 'string') cfg.customInstructions = body.customInstructions;
    if (Array.isArray(body.promptTemplates)) {
      cfg.promptTemplates = body.promptTemplates
        .filter(t => t && typeof t.name === 'string' && typeof t.text === 'string')
        .slice(0, 100);
    }
    configLib.save(cfg);
    return json(res, 200, { ok: true });
  }

  // ----- Historial de conversaciones en disco -----
  if (url.pathname === '/api/chats' && req.method === 'GET') {
    return json(res, 200, { chats: chats.list() });
  }
  if (url.pathname === '/api/chats' && req.method === 'POST') {
    const body = await readBody(req, 60 * 1024 * 1024);
    if (!body.chat || !Array.isArray(body.chat.messages)) return json(res, 400, { error: 'Falta chat.messages' });
    return json(res, 200, { id: chats.save(body.chat) });
  }
  if (url.pathname === '/api/chats/search' && req.method === 'GET') {
    const q = url.searchParams.get('q') || '';
    return json(res, 200, { results: q.trim() ? chats.search(q.trim()) : [] });
  }
  {
    const m = url.pathname.match(/^\/api\/chats\/([\w-]+)\/export$/);
    if (m && req.method === 'GET') {
      const chat = chats.get(m[1]);
      if (!chat) return json(res, 404, { error: 'Chat no encontrado' });
      const format = url.searchParams.get('format') || 'md';
      const safeTitle = (chat.title || 'chat').replace(/[^\w áéíóúñ-]/gi, '').trim().slice(0, 40) || 'chat';
      if (format === 'json') {
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Disposition': `attachment; filename="${encodeURIComponent(safeTitle)}.json"`
        });
        return res.end(JSON.stringify(chat, null, 2));
      }
      res.writeHead(200, {
        'Content-Type': 'text/markdown; charset=utf-8',
        'Content-Disposition': `attachment; filename="${encodeURIComponent(safeTitle)}.md"`
      });
      return res.end(chats.toMarkdown(chat));
    }
  }
  {
    const m = url.pathname.match(/^\/api\/chats\/([\w-]+)$/);
    if (m && req.method === 'GET') {
      const chat = chats.get(m[1]);
      return chat ? json(res, 200, chat) : json(res, 404, { error: 'Chat no encontrado' });
    }
    if (m && req.method === 'DELETE') {
      chats.remove(m[1]);
      return json(res, 200, { ok: true });
    }
  }

  // ----- RAG: colecciones de documentos locales -----
  if (url.pathname === '/api/rag' && req.method === 'GET') {
    return json(res, 200, { collections: rag.list() });
  }
  if (url.pathname === '/api/rag/index' && req.method === 'POST') {
    const { name, folder, provider, model } = await readBody(req);
    if (!name || !folder || !provider || !model) {
      return json(res, 400, { error: 'Faltan name, folder, provider o model' });
    }
    sseStart(res);
    try {
      const result = await rag.buildIndex({
        id: Date.now().toString(36), name, folder, provider, model, cfg,
        onProgress: (done, total) => sse(res, { type: 'progress', done, total })
      });
      sse(res, { type: 'done', ...result });
    } catch (err) {
      sse(res, { type: 'error', message: err.message });
    }
    return res.end();
  }
  if (url.pathname === '/api/rag/search' && req.method === 'GET') {
    try {
      const results = await rag.search(url.searchParams.get('id'), url.searchParams.get('q') || '', cfg, 5);
      return json(res, 200, { results });
    } catch (err) {
      return json(res, 502, { error: err.message });
    }
  }
  {
    const m = url.pathname.match(/^\/api\/rag\/([\w-]+)$/);
    if (m && req.method === 'DELETE') {
      rag.remove(m[1]);
      return json(res, 200, { ok: true });
    }
  }

  // Hardware local (RAM/GPU) para el semáforo de modelos
  if (url.pathname === '/api/system' && req.method === 'GET') {
    return json(res, 200, await system.detect());
  }

  // Buscador de modelos GGUF en Hugging Face (petición iniciada por el usuario)
  if (url.pathname === '/api/hub/search' && req.method === 'GET') {
    const q = url.searchParams.get('q') || '';
    try {
      const r = await fetch('https://huggingface.co/api/models?search=' + encodeURIComponent(q) +
        '&filter=gguf&sort=downloads&direction=-1&limit=20');
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const models = (await r.json()).map(m => ({
        id: m.id || m.modelId,
        downloads: m.downloads || 0,
        likes: m.likes || 0,
        updated: m.lastModified || ''
      }));
      return json(res, 200, { models });
    } catch (err) {
      return json(res, 502, { error: 'No se pudo consultar Hugging Face: ' + err.message });
    }
  }

  // Archivos GGUF de un repo, con tamaño y semáforo según tu hardware
  if (url.pathname === '/api/hub/files' && req.method === 'GET') {
    const repo = url.searchParams.get('repo') || '';
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return json(res, 400, { error: 'repo no válido' });
    try {
      const r = await fetch('https://huggingface.co/api/models/' + repo + '?blobs=true');
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const info = await r.json();
      const sys = await system.detect();
      // Agrupar GGUF multiparte (modelo-00001-of-00003.gguf…): el semáforo debe
      // evaluar el tamaño TOTAL del modelo, no el de cada parte
      const groups = new Map();
      for (const s of (info.siblings || [])) {
        if (!s.rfilename.toLowerCase().endsWith('.gguf')) continue;
        const m = s.rfilename.match(/^(.*)-\d{5}-of-\d{5}\.gguf$/i);
        const key = m ? m[1] + '.gguf' : s.rfilename;
        const g = groups.get(key) || { file: key, size: 0, parts: 0 };
        g.size += s.size || 0;
        g.parts++;
        groups.set(key, g);
      }
      const files = [...groups.values()]
        .map(g => ({
          file: g.file,
          sizeGB: +(g.size / 1073741824).toFixed(2),
          parts: g.parts,
          verdict: system.verdict(g.size, sys)
        }))
        .sort((a, b) => a.sizeGB - b.sizeGB);
      return json(res, 200, { repo, files, system: sys });
    } catch (err) {
      return json(res, 502, { error: 'No se pudo leer el repo: ' + err.message });
    }
  }

  // Descarga de un GGUF (SSE con progreso). target: "lmstudio" | "ollama"
  if (url.pathname === '/api/hub/download' && req.method === 'POST') {
    const { repo, file, target } = await readBody(req);
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo || '') || !/^[\w./ -]+\.gguf$/i.test(file || '') || file.includes('..')) {
      return json(res, 400, { error: 'Parámetros no válidos' });
    }
    sseStart(res);
    try {
      if (target === 'ollama') {
        await ollamaPull(repo, file, res);
      } else {
        await downloadToLmStudio(repo, file, cfg, res);
      }
    } catch (err) {
      sse(res, { type: 'error', message: err.message });
    }
    return res.end();
  }

  // Estado y recarga de conectores MCP
  if (url.pathname === '/api/mcp/status' && req.method === 'GET') {
    return json(res, 200, { servers: mcp.status() });
  }
  if (url.pathname === '/api/mcp/reload' && req.method === 'POST') {
    await mcp.sync(cfg);
    return json(res, 200, { servers: mcp.status() });
  }

  // Modelos de un proveedor
  if (url.pathname === '/api/models' && req.method === 'GET') {
    const provider = url.searchParams.get('provider');
    try {
      const models = await providers.listModels(provider, cfg);
      return json(res, 200, { models });
    } catch (err) {
      return json(res, 502, { error: err.message });
    }
  }

  // Estado de servidores locales (Ollama / LM Studio / Stable Diffusion)
  if (url.pathname === '/api/status' && req.method === 'GET') {
    const [ollama, lmstudio, sd, comfy] = await Promise.all([
      providers.checkLocal('ollama', cfg),
      providers.checkLocal('lmstudio', cfg),
      providers.sdCheck(cfg),
      providers.comfyCheck(cfg)
    ]);
    return json(res, 200, { ollama, lmstudio, sd, comfy });
  }

  // Aprobación de una herramienta del agente
  if (url.pathname === '/api/approval' && req.method === 'POST') {
    const { id, approved } = await readBody(req);
    const resolve = pendingApprovals.get(id);
    if (!resolve) return json(res, 404, { error: 'Aprobación no encontrada o expirada' });
    pendingApprovals.delete(id);
    resolve(!!approved);
    return json(res, 200, { ok: true });
  }

  // Abrir VS Code en el workspace o en un archivo
  if (url.pathname === '/api/open-vscode' && req.method === 'POST') {
    const body = await readBody(req);
    const target = body.path || cfg.workspace;
    try {
      spawn('code', [target], { shell: true, detached: true, stdio: 'ignore' }).unref();
      return json(res, 200, { ok: true, opened: target });
    } catch (err) {
      return json(res, 500, { error: err.message });
    }
  }

  // Subir un adjunto (imagen/audio/vídeo). Se guarda en ~/.dedlit/media y el
  // chat solo almacena la referencia ligera "media:archivo".
  if (url.pathname === '/api/upload' && req.method === 'POST') {
    const body = await readBody(req, 80 * 1024 * 1024); // hasta ~60 MB de archivo
    try {
      const saved = media.saveDataUrl(body.dataUrl, body.name);
      return json(res, 200, saved);
    } catch (err) {
      return json(res, 400, { error: err.message });
    }
  }

  // Generar imagen: Stable Diffusion local o nube (OpenAI, xAI, Zhipu),
  // con selección automática si el proveedor actual no genera imágenes
  if (url.pathname === '/api/generate/image' && req.method === 'POST') {
    const { provider, model, prompt } = await readBody(req);
    try {
      const backend = await pickImageBackend(provider, model, cfg);
      if (!backend) {
        throw new Error('Sin backend de imágenes: arranca Stable Diffusion (Automatic1111 con --api) o configura una key de OpenAI/xAI/Zhipu.');
      }
      const { buf, label } = await generateImageBuffer(backend, prompt, cfg);
      return json(res, 200, { ...media.saveBuffer(buf, '.png', 'img'), backend: label });
    } catch (err) {
      return json(res, 502, { error: err.message });
    }
  }

  // Texto a voz. Prioridad: servidor TTS local OpenAI-compatible (config
  // ttsUrl: kokoro, openedai-speech…) → proveedor en la nube
  if (url.pathname === '/api/generate/speech' && req.method === 'POST') {
    const { provider, model, input, voice } = await readBody(req);
    try {
      let buf;
      let backend;
      if (cfg.ttsUrl) {
        const r = await fetch(cfg.ttsUrl.replace(/\/+$/, '') + '/audio/speech', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: model || 'tts-1', input, voice: voice || 'alloy', response_format: 'mp3' })
        });
        if (!r.ok) throw new Error('TTS local HTTP ' + r.status + ': ' + (await r.text()).slice(0, 200));
        buf = Buffer.from(await r.arrayBuffer());
        backend = 'TTS local';
      } else {
        buf = await providers.generateSpeech({ providerId: provider, model, input, voice, cfg });
        backend = provider;
      }
      return json(res, 200, { ...media.saveBuffer(buf, '.mp3', 'tts'), backend });
    } catch (err) {
      return json(res, 502, { error: err.message });
    }
  }

  // Transcripción. Prioridad: servidor local OpenAI-compatible (config
  // sttUrl: whisper.cpp server, faster-whisper…) → proveedor en la nube
  if (url.pathname === '/api/transcribe' && req.method === 'POST') {
    const { provider, model, ref } = await readBody(req);
    try {
      const { buf, mime, file } = media.refData(ref);
      let text;
      if (cfg.sttUrl) {
        const fd = new FormData();
        fd.append('file', new Blob([buf], { type: mime }), file);
        fd.append('model', model || 'whisper-1');
        const r = await fetch(cfg.sttUrl.replace(/\/+$/, '') + '/audio/transcriptions', { method: 'POST', body: fd });
        if (!r.ok) throw new Error('STT local HTTP ' + r.status + ': ' + (await r.text()).slice(0, 200));
        const j = await r.json();
        text = j.text ?? JSON.stringify(j);
      } else {
        text = await providers.transcribe({ providerId: provider, model, buf, mime, name: file, cfg });
      }
      return json(res, 200, { text });
    } catch (err) {
      return json(res, 502, { error: err.message });
    }
  }

  // Chat (SSE) — con o sin modo agente
  if (url.pathname === '/api/chat' && req.method === 'POST') {
    const body = await readBody(req);
    return chatHandler(req, res, body, cfg);
  }

  json(res, 404, { error: 'Ruta no encontrada' });
}

// ---------- Descarga de modelos del hub ----------

// Descarga un GGUF a la carpeta de modelos de LM Studio (estructura
// editor/modelo/archivo.gguf, que LM Studio indexa automáticamente)
async function downloadToLmStudio(repo, file, cfg, res) {
  const os = require('os');
  const baseDir = cfg.lmstudioModelsDir || path.join(os.homedir(), '.lmstudio', 'models');
  const dest = path.join(baseDir, ...repo.split('/'), path.basename(file));
  fs.mkdirSync(path.dirname(dest), { recursive: true });

  const dl = await fetch(`https://huggingface.co/${repo}/resolve/main/${encodeURI(file)}`, { redirect: 'follow' });
  if (!dl.ok) {
    throw new Error('HTTP ' + dl.status + ' al descargar de Hugging Face' +
      (dl.status === 401 || dl.status === 403 ? ' (repo privado o con acceso restringido)' : ''));
  }
  const total = +(dl.headers.get('content-length') || 0);
  const tmp = dest + '.part';
  const out = fs.createWriteStream(tmp);
  let received = 0;
  let lastPct = -1;
  for await (const chunk of dl.body) {
    out.write(chunk);
    received += chunk.length;
    const pct = total ? Math.floor(received / total * 100) : 0;
    if (pct !== lastPct) {
      lastPct = pct;
      sse(res, { type: 'progress', pct, mb: +(received / 1048576).toFixed(0), totalMb: +(total / 1048576).toFixed(0) });
    }
  }
  await new Promise(r => out.end(r));
  fs.renameSync(tmp, dest);
  sse(res, { type: 'done', path: dest, note: 'LM Studio lo indexará automáticamente (Mis modelos)' });
}

// Descarga vía Ollama: "ollama pull hf.co/repo:CUANT" (Ollama gestiona el registro)
function ollamaPull(repo, file, res) {
  return new Promise((resolve) => {
    const quant = (file.match(/\b(I?Q\d[\w-]*?|F16|F32|BF16)\b(?=[.-])/i) || [])[0];
    const ref = 'hf.co/' + repo + (quant ? ':' + quant.toUpperCase() : '');
    sse(res, { type: 'progress', pct: 0, note: 'ollama pull ' + ref });
    const child = spawn('ollama', ['pull', ref], { windowsHide: true, shell: process.platform === 'win32' });
    let lastLine = '';
    const onData = d => {
      const line = d.toString().split('\n').filter(Boolean).pop() || '';
      if (line && line !== lastLine) {
        lastLine = line;
        const pct = (line.match(/(\d+)%/) || [])[1];
        sse(res, { type: 'progress', pct: pct ? +pct : undefined, note: line.replace(/\r|\[[^a-zA-Z]*[a-zA-Z]/g, '').slice(-120) });
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', err => { sse(res, { type: 'error', message: 'No se pudo ejecutar ollama: ' + err.message + ' — ¿está instalado?' }); resolve(); });
    child.on('close', code => {
      if (code === 0) sse(res, { type: 'done', path: ref, note: 'Modelo registrado en Ollama como ' + ref });
      else sse(res, { type: 'error', message: 'ollama pull terminó con código ' + code + '. ' + lastLine });
      resolve();
    });
  });
}

// ---------- Bucle de chat / agente ----------

// Backends de generación de imagen. Prioridad en modo automático:
// Stable Diffusion local (gratis y privado) → nube con key configurada.
const IMAGE_CLOUD = [['openai', 'gpt-image-1'], ['xai', 'grok-2-image'], ['zhipu', 'cogview-4']];

async function pickImageBackend(provider, model, cfg) {
  if (provider === 'sdwebui' || provider === 'sd') return { kind: 'sd' };
  if (provider === 'comfyui' || provider === 'comfy') return { kind: 'comfy' };
  const cloud = IMAGE_CLOUD.find(c => c[0] === provider);
  if (cloud) return { kind: 'cloud', provider, model: model || cloud[1] };
  // automático: local primero (SD WebUI → ComfyUI), luego nube con key
  const sd = await providers.sdCheck(cfg);
  if (sd.online) return { kind: 'sd' };
  const comfy = await providers.comfyCheck(cfg);
  if (comfy.online && comfy.models.length) return { kind: 'comfy' };
  for (const [p, m] of IMAGE_CLOUD) {
    if (cfg.keys[p]) return { kind: 'cloud', provider: p, model: m };
  }
  return null;
}

async function generateImageBuffer(backend, prompt, cfg) {
  if (backend.kind === 'sd') {
    return { buf: await providers.sdGenerate({ prompt, cfg }), label: 'Stable Diffusion local' };
  }
  if (backend.kind === 'comfy') {
    return { buf: await providers.comfyGenerate({ prompt, cfg }), label: 'ComfyUI local' };
  }
  const buf = await providers.generateImage({ providerId: backend.provider, model: backend.model, prompt, cfg });
  return { buf, label: backend.provider + ':' + backend.model };
}

// Herramienta search_docs del agente: busca en todas las colecciones RAG
async function searchDocsTool(args, cfg) {
  try {
    const hits = await rag.searchAll(String(args.query || ''), cfg, Math.min(args.top_k || 5, 10));
    if (!hits.length) return 'Sin resultados. Colecciones disponibles: ' + (rag.list().map(c => c.name).join(', ') || 'ninguna — el usuario no ha indexado documentos (botón 📚 Documentos).');
    return hits.map(h => `【${h.file}】 (${h.collection}, similitud ${h.score})\n${h.text}`).join('\n\n---\n\n').slice(0, 30000);
  } catch (err) {
    return 'ERROR en la búsqueda documental: ' + err.message;
  }
}

async function generateImageTool(args, cfg) {
  const backend = await pickImageBackend(args.provider, args.model, cfg);
  if (!backend) {
    return 'ERROR: no hay backend de imágenes disponible: ni Stable Diffusion local activo (Automatic1111 en ' + (cfg.sdWebuiUrl || 'http://127.0.0.1:7860') + ') ni API key de OpenAI/xAI/Zhipu. Opciones: pedir al usuario que arranque SD WebUI con --api o configure una key, o buscar un conector MCP.';
  }
  try {
    const { buf, label } = await generateImageBuffer(backend, args.prompt, cfg);
    const saved = media.saveBuffer(buf, '.png', 'img');
    return 'SHOWMEDIA::' + JSON.stringify({
      ref: saved.ref, kind: 'image',
      caption: String(args.prompt || '').slice(0, 100),
      forModel: '[Imagen generada con ' + label + ' y mostrada al usuario en el chat. Archivo: ' + saved.file + ']'
    });
  } catch (err) {
    return 'ERROR al generar la imagen: ' + err.message;
  }
}

async function chatHandler(req, res, body, cfg) {
  const { provider, model, messages, agentMode } = body;
  if (!provider || !model || !Array.isArray(messages)) {
    return json(res, 400, { error: 'Faltan provider, model o messages' });
  }

  sseStart(res);
  let aborted = false;
  req.on('close', () => { aborted = true; });

  const msgs = [...messages];
  if (agentMode && !msgs.some(m => m.role === 'system')) {
    msgs.unshift({ role: 'system', content: agent.systemPrompt(cfg.workspace) });
  }
  const newMessages = agentMode && msgs.length > messages.length ? [msgs[0]] : [];
  // Instrucciones personalizadas: se añaden solo a la copia enviada al
  // proveedor (nunca al historial guardado, para no duplicarlas por turno)
  if (cfg.customInstructions && cfg.customInstructions.trim()) {
    const extra = 'Instrucciones personalizadas del usuario (respétalas siempre):\n' + cfg.customInstructions.trim();
    const idx = msgs.findIndex(m => m.role === 'system');
    if (idx >= 0) msgs[idx] = { role: 'system', content: msgs[idx].content + '\n\n' + extra };
    else msgs.unshift({ role: 'system', content: extra });
  }
  // Contexto documental (RAG): buscar en la colección elegida los fragmentos
  // más afines a la última pregunta y dárselos al modelo como contexto
  if (body.ragId) {
    try {
      const lastUser = [...msgs].reverse().find(m => m.role === 'user');
      const q = typeof lastUser?.content === 'string'
        ? lastUser.content
        : (lastUser?.content || []).filter(p => p.type === 'text').map(p => p.text).join(' ');
      if (q) {
        const hits = await rag.search(body.ragId, q, cfg, 5);
        if (hits.length) {
          const ctx = hits.map(h => `【${h.file}】\n${h.text}`).join('\n\n---\n\n');
          msgs.unshift({
            role: 'system',
            content: 'Contexto extraído de los documentos del usuario. Básate en él para responder y cita el archivo entre 【】 cuando lo uses; si el contexto no contiene la respuesta, dilo.\n\n' + ctx
          });
        }
      }
    } catch (err) {
      sse(res, { type: 'error', message: 'RAG: ' + err.message });
    }
  }
  if (agentMode) {
    try { await mcp.sync(cfg); } catch { /* los conectores no deben tumbar el chat */ }
  }
  const maxIter = cfg.maxAgentIterations || 25;

  try {
    for (let iter = 0; iter < maxIter && !aborted; iter++) {
      let text = '';
      let calls = [];
      // Recalcular en cada vuelta: add_mcp_connector puede añadir herramientas
      // en mitad de la conversación
      const tools = agentMode ? [...agent.TOOLS, ...mcp.MANAGEMENT_TOOLS, ...mcp.getTools()] : null;

      const stream = providers.chatStream({
        providerId: provider, model, messages: media.resolveMessages(msgs), tools,
        temperature: cfg.temperature, cfg
      });

      for await (const ev of stream) {
        if (aborted) break;
        if (ev.type === 'text') { text += ev.text; sse(res, ev); }
        else if (ev.type === 'tool_calls') calls = ev.calls;
        else if (ev.type === 'error') {
          sse(res, ev);
          sse(res, { type: 'done', messages: newMessages });
          return res.end();
        }
      }

      if (!calls.length) {
        // Respuesta final del modelo
        const finalMsg = { role: 'assistant', content: text };
        newMessages.push(finalMsg);
        sse(res, { type: 'done', messages: newMessages });
        return res.end();
      }

      // El modelo pidió herramientas
      const assistantMsg = {
        role: 'assistant',
        content: text || null,
        tool_calls: calls.map(c => ({
          id: c.id, type: 'function',
          function: { name: c.name, arguments: JSON.stringify(c.args) }
        }))
      };
      msgs.push(assistantMsg);
      newMessages.push(assistantMsg);

      const pendingMedia = []; // mensajes multimedia a insertar tras los tool results
      for (const call of calls) {
        if (aborted) break;
        const category = mcp.isManagementTool(call.name) ? mcp.MANAGEMENT_TOOLS.find(t => t.name === call.name).category
          : mcp.isMcpTool(call.name) ? mcp.toolCategory(call.name)
          : agent.toolCategory(call.name);
        const auto = cfg.autoApprove[category];
        let approved = true;

        sse(res, { type: 'tool_call', id: call.id, name: call.name, args: call.args, category });

        if (!auto) {
          sse(res, { type: 'approval_request', id: call.id, name: call.name, args: call.args, category });
          approved = await new Promise(resolve => {
            pendingApprovals.set(call.id, resolve);
            setTimeout(() => {
              if (pendingApprovals.delete(call.id)) resolve(false);
            }, 10 * 60 * 1000);
          });
        }

        let result = !approved
          ? '[El usuario rechazó la ejecución de esta herramienta. Pregunta cómo proceder o intenta otra vía.]'
          : call.name === 'generate_image'
            ? await generateImageTool(call.args, cfg)
            : call.name === 'search_docs'
            ? await searchDocsTool(call.args, cfg)
            : mcp.isManagementTool(call.name)
              ? await mcp.manage(call.name, call.args, cfg)
              : mcp.isMcpTool(call.name)
                ? await mcp.execute(call.name, call.args)
                : await agent.execute(call.name, call.args, cfg.workspace);

        // show_media / generate_image devuelven un marcador: emitir el medio
        // al chat y darle al modelo solo un texto neutro
        if (typeof result === 'string' && result.startsWith('SHOWMEDIA::')) {
          try {
            const info = JSON.parse(result.slice('SHOWMEDIA::'.length));
            const parts = [];
            if (info.caption) parts.push({ type: 'text', text: '📎 ' + info.caption });
            parts.push(
              info.kind === 'image' ? { type: 'image_url', image_url: { url: info.ref } }
              : info.kind === 'audio' ? { type: 'input_audio', input_audio: { data: info.ref, format: 'mp3' } }
              : { type: 'video_url', video_url: { url: info.ref } }
            );
            pendingMedia.push({ role: 'assistant', generated: true, content: parts });
            sse(res, { type: 'media', content: parts });
            result = info.forModel || '[Archivo multimedia mostrado al usuario.]';
          } catch { /* marcador corrupto: dejar el texto tal cual */ }
        }

        sse(res, { type: 'tool_result', id: call.id, approved, result: result.slice(0, 4000) });
        const toolMsg = { role: 'tool', tool_call_id: call.id, content: result };
        msgs.push(toolMsg);
        newMessages.push(toolMsg);
      }
      // insertar los medios después de todos los tool results del turno para
      // no romper el emparejamiento tool_call → tool_result
      for (const m of pendingMedia) {
        msgs.push(m);
        newMessages.push(m);
      }
    }
    sse(res, { type: 'error', message: 'Se alcanzó el máximo de iteraciones del agente (' + maxIter + ')' });
    sse(res, { type: 'done', messages: newMessages });
    res.end();
  } catch (err) {
    try {
      sse(res, { type: 'error', message: err.message });
      sse(res, { type: 'done', messages: newMessages });
      res.end();
    } catch { /* conexión cerrada */ }
  }
}

// ---------- Gateway OpenAI-compatible (para VS Code: Continue, Cline, etc.) ----------
// Modelo en formato "proveedor:modelo", p.ej. "anthropic:claude-sonnet-5" u "ollama:llama3.1".

async function handleGateway(req, res, url) {
  const cfg = configLib.load();

  if (url.pathname === '/v1/models' && req.method === 'GET') {
    const data = [];
    for (const id of Object.keys(providers.REGISTRY)) {
      try {
        const models = await providers.listModels(id, cfg);
        for (const m of models) data.push({ id: id + ':' + m, object: 'model', owned_by: id });
      } catch { /* proveedor sin key o apagado */ }
    }
    return json(res, 200, { object: 'list', data });
  }

  if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
    const body = await readBody(req);
    const [providerId, ...rest] = String(body.model || '').split(':');
    const model = rest.join(':');
    if (!providers.REGISTRY[providerId] || !model) {
      return json(res, 400, { error: { message: 'Usa model con formato "proveedor:modelo", p.ej. "ollama:llama3.1"' } });
    }
    // Herramientas (function calling): del formato OpenAI al neutro interno
    const tools = Array.isArray(body.tools) && body.tools.length
      ? body.tools
          .filter(t => t.type === 'function' && t.function)
          .map(t => ({ name: t.function.name, description: t.function.description || '', parameters: t.function.parameters || { type: 'object', properties: {} } }))
      : null;

    const stream = providers.chatStream({
      providerId, model,
      messages: media.resolveMessages(body.messages || []),
      tools,
      temperature: body.temperature ?? cfg.temperature,
      cfg
    });

    const toOpenAiCalls = calls => calls.map((c, i) => ({
      index: i, id: c.id, type: 'function',
      function: { name: c.name, arguments: JSON.stringify(c.args) }
    }));

    if (body.stream) {
      sseStart(res);
      const chunkId = 'chatcmpl-' + Date.now();
      const chunk = (delta, finish = null) => sse(res, {
        id: chunkId, object: 'chat.completion.chunk', model: body.model,
        choices: [{ index: 0, delta, finish_reason: finish }]
      });
      let finish = 'stop';
      for await (const ev of stream) {
        if (ev.type === 'text') chunk({ content: ev.text });
        else if (ev.type === 'tool_calls') { chunk({ tool_calls: toOpenAiCalls(ev.calls) }); finish = 'tool_calls'; }
        else if (ev.type === 'error') sse(res, { error: { message: ev.message } });
      }
      chunk({}, finish);
      res.write('data: [DONE]\n\n');
      return res.end();
    }

    let text = '';
    let calls = null;
    let error = null;
    for await (const ev of stream) {
      if (ev.type === 'text') text += ev.text;
      else if (ev.type === 'tool_calls') calls = ev.calls;
      else if (ev.type === 'error') error = ev.message;
    }
    if (error) return json(res, 502, { error: { message: error } });
    const message = { role: 'assistant', content: text || (calls ? null : '') };
    if (calls) message.tool_calls = toOpenAiCalls(calls);
    return json(res, 200, {
      id: 'chatcmpl-' + Date.now(), object: 'chat.completion', model: body.model,
      choices: [{ index: 0, message, finish_reason: calls ? 'tool_calls' : 'stop' }]
    });
  }

  json(res, 404, { error: { message: 'Ruta no encontrada' } });
}

// ---------- Estáticos ----------

function serveStatic(res, url) {
  let file = url.pathname === '/' ? '/index.html' : url.pathname;
  file = path.normalize(file).replace(/^([/\\])+/, '');
  const full = path.join(PUBLIC, file);
  if (!full.startsWith(PUBLIC) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) {
    res.writeHead(404); return res.end('404');
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream' });
  fs.createReadStream(full).pipe(res);
}

// ---------- Servidor ----------

function serveMedia(res, url) {
  const full = media.filePath(decodeURIComponent(url.pathname.slice('/media/'.length)));
  if (!fs.existsSync(full) || fs.statSync(full).isDirectory()) {
    res.writeHead(404); return res.end('404');
  }
  res.writeHead(200, { 'Content-Type': media.mimeOf(full), 'Cache-Control': 'max-age=31536000' });
  fs.createReadStream(full).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    if (url.pathname.startsWith('/v1/')) return await handleGateway(req, res, url);
    if (url.pathname.startsWith('/media/')) return serveMedia(res, url);
    serveStatic(res, url);
  } catch (err) {
    try { json(res, 500, { error: err.message }); } catch { /* ya respondido */ }
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('');
  console.log('  DEDLIT Studio — frontend local de IA');
  console.log('  ------------------------------------');
  console.log(`  Interfaz:  http://127.0.0.1:${PORT}`);
  console.log(`  Gateway:   http://127.0.0.1:${PORT}/v1  (OpenAI-compatible, model = "proveedor:modelo")`);
  console.log(`  Config:    ${configLib.DIR}`);
  console.log('');
});
