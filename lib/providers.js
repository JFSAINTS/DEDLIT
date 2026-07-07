'use strict';
// Registro de proveedores y adaptadores de streaming.
// Todo se unifica en un formato interno de mensajes estilo OpenAI:
//   {role:'system'|'user'|'assistant'|'tool', content, tool_calls?, tool_call_id?}
// y el stream emite eventos: {type:'text',text} | {type:'tool_calls',calls} | {type:'error',message}

const configLib = require('./config');

const REGISTRY = {
  // 127.0.0.1 en vez de localhost: en Windows, Node resuelve localhost a ::1
  // (IPv6) primero y LM Studio/Ollama solo escuchan en IPv4 → "fetch failed"
  ollama:    { name: 'Ollama (local)',        kind: 'openai',    base: 'http://127.0.0.1:11434/v1', needsKey: false, local: true },
  lmstudio:  { name: 'LM Studio (local)',     kind: 'openai',    base: 'http://127.0.0.1:1234/v1',  needsKey: false, local: true },
  anthropic: { name: 'Anthropic (Claude)',    kind: 'anthropic', base: 'https://api.anthropic.com', needsKey: true },
  openai:    { name: 'OpenAI',                kind: 'openai',    base: 'https://api.openai.com/v1', needsKey: true },
  google:    { name: 'Google (Gemini)',       kind: 'openai',    base: 'https://generativelanguage.googleapis.com/v1beta/openai', needsKey: true },
  xai:       { name: 'xAI (Grok)',            kind: 'openai',    base: 'https://api.x.ai/v1',       needsKey: true },
  deepseek:  { name: 'DeepSeek',              kind: 'openai',    base: 'https://api.deepseek.com/v1', needsKey: true },
  qwen:      { name: 'Alibaba Qwen',          kind: 'openai',    base: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1', needsKey: true },
  moonshot:  { name: 'Moonshot (Kimi)',       kind: 'openai',    base: 'https://api.moonshot.ai/v1', needsKey: true },
  zhipu:     { name: 'Zhipu (GLM)',           kind: 'openai',    base: 'https://open.bigmodel.cn/api/paas/v4', needsKey: true }
};

function baseUrl(providerId, cfg) {
  return (cfg.baseUrls[providerId] || REGISTRY[providerId].base)
    .replace(/\/+$/, '')
    // normaliza configuraciones antiguas guardadas con localhost (trampa IPv6)
    .replace(/^http:\/\/localhost:/i, 'http://127.0.0.1:');
}

async function listModels(providerId, cfg) {
  const p = REGISTRY[providerId];
  if (!p) throw new Error('Proveedor desconocido: ' + providerId);
  const key = configLib.getKey(cfg, providerId);
  if (p.needsKey && !key) throw new Error('Falta la API key de ' + p.name);

  if (p.kind === 'anthropic') {
    const res = await fetch(baseUrl(providerId, cfg) + '/v1/models?limit=100', {
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' }
    });
    if (!res.ok) throw new Error('HTTP ' + res.status + ': ' + (await res.text()).slice(0, 300));
    const json = await res.json();
    return (json.data || []).map(m => m.id);
  }

  const headers = {};
  if (key) headers.Authorization = 'Bearer ' + key;
  const res = await fetch(baseUrl(providerId, cfg) + '/models', { headers });
  if (!res.ok) throw new Error('HTTP ' + res.status + ': ' + (await res.text()).slice(0, 300));
  const json = await res.json();
  return (json.data || []).map(m => m.id).sort();
}

// ---------- Adaptador OpenAI-compatible ----------

async function* openaiStream({ providerId, model, messages, tools, temperature, cfg }) {
  const key = configLib.getKey(cfg, providerId);
  const body = {
    model,
    messages,
    stream: true,
    temperature
  };
  if (tools && tools.length) {
    body.tools = tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
  }
  const headers = { 'Content-Type': 'application/json' };
  if (key) headers.Authorization = 'Bearer ' + key;

  const res = await fetch(baseUrl(providerId, cfg) + '/chat/completions', {
    method: 'POST', headers, body: JSON.stringify(body)
  });
  if (!res.ok) {
    yield { type: 'error', message: 'HTTP ' + res.status + ': ' + (await res.text()).slice(0, 500) };
    return;
  }

  const toolCalls = []; // acumulación por índice
  for await (const data of sseLines(res.body)) {
    if (data === '[DONE]') break;
    let chunk;
    try { chunk = JSON.parse(data); } catch { continue; }
    const choice = chunk.choices && chunk.choices[0];
    if (!choice) continue;
    const delta = choice.delta || {};
    if (delta.content) yield { type: 'text', text: delta.content };
    if (delta.tool_calls) {
      for (const tc of delta.tool_calls) {
        const i = tc.index ?? 0;
        if (!toolCalls[i]) toolCalls[i] = { id: '', name: '', args: '' };
        if (tc.id) toolCalls[i].id = tc.id;
        if (tc.function?.name) toolCalls[i].name += tc.function.name;
        if (tc.function?.arguments) toolCalls[i].args += tc.function.arguments;
      }
    }
  }
  const calls = toolCalls.filter(Boolean).map((c, i) => ({
    id: c.id || ('call_' + Date.now() + '_' + i),
    name: c.name,
    args: safeParse(c.args)
  }));
  if (calls.length) yield { type: 'tool_calls', calls };
}

// ---------- Adaptador Anthropic (Messages API nativa) ----------

// Convierte partes multimodales (formato OpenAI, con data-URIs ya resueltos)
// a bloques de contenido de Anthropic. Claude acepta imágenes; audio y vídeo
// no, así que se sustituyen por una nota para que el modelo sepa que existían.
function toAnthropicContent(parts) {
  const out = [];
  for (const p of parts) {
    if (p.type === 'text') {
      if (p.text) out.push({ type: 'text', text: p.text });
    } else if (p.type === 'image_url') {
      const m = /^data:([^;]+);base64,(.+)$/s.exec(p.image_url?.url || '');
      if (m) out.push({ type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } });
      else out.push({ type: 'text', text: '[imagen no disponible]' });
    } else if (p.type === 'input_audio') {
      out.push({ type: 'text', text: '[El usuario adjuntó un audio, pero este proveedor no admite entrada de audio.]' });
    } else if (p.type === 'video_url') {
      out.push({ type: 'text', text: '[El usuario adjuntó un vídeo, pero este proveedor no admite entrada de vídeo.]' });
    }
  }
  return out.length ? out : [{ type: 'text', text: '(mensaje vacío)' }];
}

function toAnthropicMessages(messages) {
  const out = [];
  let system = '';
  for (const m of messages) {
    if (m.role === 'system') { system += (system ? '\n' : '') + m.content; continue; }
    if (m.role === 'tool') {
      const block = { type: 'tool_result', tool_use_id: m.tool_call_id, content: String(m.content ?? '') };
      const last = out[out.length - 1];
      if (last && last.role === 'user' && Array.isArray(last.content) && last.content[0]?.type === 'tool_result') {
        last.content.push(block);
      } else {
        out.push({ role: 'user', content: [block] });
      }
      continue;
    }
    if (m.role === 'assistant' && m.tool_calls?.length) {
      const content = [];
      if (m.content) content.push({ type: 'text', text: m.content });
      for (const tc of m.tool_calls) {
        content.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input: safeParse(tc.function.arguments) });
      }
      out.push({ role: 'assistant', content });
      continue;
    }
    out.push({
      role: m.role,
      content: Array.isArray(m.content) ? toAnthropicContent(m.content) : String(m.content ?? '')
    });
  }
  return { system, messages: out };
}

async function* anthropicStream({ providerId, model, messages, tools, temperature, cfg }) {
  const key = configLib.getKey(cfg, providerId);
  const { system, messages: msgs } = toAnthropicMessages(messages);
  const body = { model, max_tokens: 8192, messages: msgs, stream: true, temperature };
  if (system) body.system = system;
  if (tools && tools.length) {
    body.tools = tools.map(t => ({ name: t.name, description: t.description, input_schema: t.parameters }));
  }

  const res = await fetch(baseUrl(providerId, cfg) + '/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    yield { type: 'error', message: 'HTTP ' + res.status + ': ' + (await res.text()).slice(0, 500) };
    return;
  }

  const calls = [];
  let current = null; // bloque tool_use en curso
  for await (const data of sseLines(res.body)) {
    let ev;
    try { ev = JSON.parse(data); } catch { continue; }
    switch (ev.type) {
      case 'content_block_start':
        if (ev.content_block?.type === 'tool_use') {
          current = { id: ev.content_block.id, name: ev.content_block.name, argsJson: '' };
        }
        break;
      case 'content_block_delta':
        if (ev.delta?.type === 'text_delta') yield { type: 'text', text: ev.delta.text };
        else if (ev.delta?.type === 'input_json_delta' && current) current.argsJson += ev.delta.partial_json;
        break;
      case 'content_block_stop':
        if (current) {
          calls.push({ id: current.id, name: current.name, args: safeParse(current.argsJson) });
          current = null;
        }
        break;
      case 'error':
        yield { type: 'error', message: JSON.stringify(ev.error).slice(0, 500) };
        return;
    }
  }
  if (calls.length) yield { type: 'tool_calls', calls };
}

// ---------- Utilidades ----------

function safeParse(s) {
  if (typeof s === 'object' && s !== null) return s;
  try { return JSON.parse(s || '{}'); } catch { return { _raw: s }; }
}

// Itera las líneas "data: ..." de un stream SSE
async function* sseLines(readable) {
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of readable) {
    buf += decoder.decode(chunk, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).replace(/\r$/, '');
      buf = buf.slice(idx + 1);
      if (line.startsWith('data:')) yield line.slice(5).trim();
    }
  }
}

function chatStream(opts) {
  const p = REGISTRY[opts.providerId];
  if (!p) throw new Error('Proveedor desconocido: ' + opts.providerId);
  return p.kind === 'anthropic' ? anthropicStream(opts) : openaiStream(opts);
}

// ---------- Generación multimedia (endpoints OpenAI-compatibles) ----------

function authHeaders(providerId, cfg, json = true) {
  const key = configLib.getKey(cfg, providerId);
  const p = REGISTRY[providerId];
  if (p.needsKey && !key) throw new Error('Falta la API key de ' + p.name);
  const h = json ? { 'Content-Type': 'application/json' } : {};
  if (key) h.Authorization = 'Bearer ' + key;
  return h;
}

// POST /images/generations → Buffer PNG
async function generateImage({ providerId, model, prompt, size, cfg }) {
  const p = REGISTRY[providerId];
  if (!p) throw new Error('Proveedor desconocido');
  if (p.kind !== 'openai') throw new Error(p.name + ' no expone un endpoint de generación de imágenes OpenAI-compatible. Usa OpenAI (gpt-image-1/dall-e-3), xAI (grok-2-image) o Zhipu (cogview).');
  const body = { model, prompt, n: 1 };
  if (size) body.size = size;
  // gpt-image-1 no acepta response_format (siempre devuelve b64); dall-e y otros sí
  if (!/gpt-image/i.test(model)) body.response_format = 'b64_json';
  const res = await fetch(baseUrl(providerId, cfg) + '/images/generations', {
    method: 'POST', headers: authHeaders(providerId, cfg), body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error('HTTP ' + res.status + ': ' + (await res.text()).slice(0, 500));
  const json = await res.json();
  const item = (json.data || [])[0] || {};
  if (item.b64_json) return Buffer.from(item.b64_json, 'base64');
  if (item.url) {
    const r = await fetch(item.url);
    if (!r.ok) throw new Error('No se pudo descargar la imagen generada (HTTP ' + r.status + ')');
    return Buffer.from(await r.arrayBuffer());
  }
  throw new Error('El proveedor no devolvió ninguna imagen');
}

// POST /audio/speech → Buffer MP3
async function generateSpeech({ providerId, model, input, voice, cfg }) {
  const p = REGISTRY[providerId];
  if (!p) throw new Error('Proveedor desconocido');
  if (p.kind !== 'openai') throw new Error(p.name + ' no expone un endpoint de texto-a-voz OpenAI-compatible. Usa OpenAI (tts-1, gpt-4o-mini-tts) u otro compatible.');
  const res = await fetch(baseUrl(providerId, cfg) + '/audio/speech', {
    method: 'POST', headers: authHeaders(providerId, cfg),
    body: JSON.stringify({ model, input, voice: voice || 'alloy', response_format: 'mp3' })
  });
  if (!res.ok) throw new Error('HTTP ' + res.status + ': ' + (await res.text()).slice(0, 500));
  return Buffer.from(await res.arrayBuffer());
}

// POST /audio/transcriptions (multipart) → texto
async function transcribe({ providerId, model, buf, mime, name, cfg }) {
  const p = REGISTRY[providerId];
  if (!p) throw new Error('Proveedor desconocido');
  if (p.kind !== 'openai') throw new Error(p.name + ' no expone un endpoint de transcripción OpenAI-compatible. Usa OpenAI (whisper-1, gpt-4o-transcribe) u otro compatible.');
  const fd = new FormData();
  fd.append('file', new Blob([buf], { type: mime }), name || 'audio.mp3');
  fd.append('model', model);
  const res = await fetch(baseUrl(providerId, cfg) + '/audio/transcriptions', {
    method: 'POST', headers: authHeaders(providerId, cfg, false), body: fd
  });
  if (!res.ok) throw new Error('HTTP ' + res.status + ': ' + (await res.text()).slice(0, 500));
  const json = await res.json();
  return json.text ?? JSON.stringify(json);
}

async function checkLocal(providerId, cfg) {
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 1500);
    const res = await fetch(baseUrl(providerId, cfg) + '/models', { signal: controller.signal });
    clearTimeout(t);
    if (!res.ok) return { online: false };
    const json = await res.json();
    return { online: true, models: (json.data || []).map(m => m.id) };
  } catch {
    return { online: false };
  }
}

module.exports = { REGISTRY, listModels, chatStream, checkLocal, generateImage, generateSpeech, transcribe };
