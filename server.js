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
    configLib.save(cfg);
    return json(res, 200, { ok: true });
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

  // Estado de servidores locales (Ollama / LM Studio)
  if (url.pathname === '/api/status' && req.method === 'GET') {
    const [ollama, lmstudio] = await Promise.all([
      providers.checkLocal('ollama', cfg),
      providers.checkLocal('lmstudio', cfg)
    ]);
    return json(res, 200, { ollama, lmstudio });
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

  // Generar imagen (OpenAI, xAI grok-2-image, Zhipu cogview, etc.)
  if (url.pathname === '/api/generate/image' && req.method === 'POST') {
    const { provider, model, prompt, size } = await readBody(req);
    try {
      const buf = await providers.generateImage({ providerId: provider, model, prompt, size, cfg });
      return json(res, 200, media.saveBuffer(buf, '.png', 'img'));
    } catch (err) {
      return json(res, 502, { error: err.message });
    }
  }

  // Texto a voz (OpenAI tts-1 / gpt-4o-mini-tts, etc.)
  if (url.pathname === '/api/generate/speech' && req.method === 'POST') {
    const { provider, model, input, voice } = await readBody(req);
    try {
      const buf = await providers.generateSpeech({ providerId: provider, model, input, voice, cfg });
      return json(res, 200, media.saveBuffer(buf, '.mp3', 'tts'));
    } catch (err) {
      return json(res, 502, { error: err.message });
    }
  }

  // Transcribir un audio adjunto (whisper-1, gpt-4o-transcribe, etc.)
  if (url.pathname === '/api/transcribe' && req.method === 'POST') {
    const { provider, model, ref } = await readBody(req);
    try {
      const { buf, mime, file } = media.refData(ref);
      const text = await providers.transcribe({ providerId: provider, model, buf, mime, name: file, cfg });
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

// ---------- Bucle de chat / agente ----------

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
  let tools = null;
  if (agentMode) {
    try { await mcp.sync(cfg); } catch { /* los conectores no deben tumbar el chat */ }
    tools = [...agent.TOOLS, ...mcp.getTools()];
  }
  const maxIter = cfg.maxAgentIterations || 25;

  try {
    for (let iter = 0; iter < maxIter && !aborted; iter++) {
      let text = '';
      let calls = [];

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

      for (const call of calls) {
        if (aborted) break;
        const category = mcp.isMcpTool(call.name) ? mcp.toolCategory(call.name) : agent.toolCategory(call.name);
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

        const result = !approved
          ? '[El usuario rechazó la ejecución de esta herramienta. Pregunta cómo proceder o intenta otra vía.]'
          : mcp.isMcpTool(call.name)
            ? await mcp.execute(call.name, call.args)
            : await agent.execute(call.name, call.args, cfg.workspace);

        sse(res, { type: 'tool_result', id: call.id, approved, result: result.slice(0, 4000) });
        const toolMsg = { role: 'tool', tool_call_id: call.id, content: result };
        msgs.push(toolMsg);
        newMessages.push(toolMsg);
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
    const stream = providers.chatStream({
      providerId, model,
      messages: media.resolveMessages(body.messages || []),
      tools: null,
      temperature: body.temperature ?? cfg.temperature,
      cfg
    });

    if (body.stream) {
      sseStart(res);
      const chunkId = 'chatcmpl-' + Date.now();
      for await (const ev of stream) {
        if (ev.type === 'text') {
          sse(res, {
            id: chunkId, object: 'chat.completion.chunk', model: body.model,
            choices: [{ index: 0, delta: { content: ev.text }, finish_reason: null }]
          });
        } else if (ev.type === 'error') {
          sse(res, { error: { message: ev.message } });
        }
      }
      sse(res, {
        id: chunkId, object: 'chat.completion.chunk', model: body.model,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
      });
      res.write('data: [DONE]\n\n');
      return res.end();
    }

    let text = '';
    let error = null;
    for await (const ev of stream) {
      if (ev.type === 'text') text += ev.text;
      else if (ev.type === 'error') error = ev.message;
    }
    if (error) return json(res, 502, { error: { message: error } });
    return json(res, 200, {
      id: 'chatcmpl-' + Date.now(), object: 'chat.completion', model: body.model,
      choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }]
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
