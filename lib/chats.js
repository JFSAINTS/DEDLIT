'use strict';
// Historial de conversaciones en disco (~/.dedlit/chats), un JSON por chat.
// Sustituye al localStorage del navegador: sobrevive a limpiezas del navegador,
// se comparte entre navegadores y permite búsqueda y exportación.

const fs = require('fs');
const path = require('path');
const configLib = require('./config');

const DIR = path.join(configLib.DIR, 'chats');

function ensure() {
  if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true });
}

function fileOf(id) {
  return path.join(DIR, String(id).replace(/[^\w-]/g, '') + '.json');
}

function list() {
  ensure();
  const out = [];
  for (const f of fs.readdirSync(DIR)) {
    if (!f.endsWith('.json')) continue;
    try {
      const c = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
      out.push({ id: c.id, title: c.title || 'Sin título', updatedAt: c.updatedAt || 0, count: (c.messages || []).length });
    } catch { /* archivo corrupto: ignorar */ }
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

function get(id) {
  try { return JSON.parse(fs.readFileSync(fileOf(id), 'utf8')); } catch { return null; }
}

function save(chat) {
  ensure();
  if (!chat.id) chat.id = Date.now().toString(36);
  chat.updatedAt = Date.now();
  fs.writeFileSync(fileOf(chat.id), JSON.stringify(chat));
  return chat.id;
}

function remove(id) {
  try { fs.unlinkSync(fileOf(id)); } catch { /* ya no existe */ }
}

// Texto plano de un mensaje (para búsqueda y exportación)
function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter(p => p.type === 'text').map(p => p.text).join('\n');
  return '';
}

function search(q) {
  const needle = String(q).toLowerCase();
  const hits = [];
  for (const meta of list()) {
    const c = get(meta.id);
    if (!c) continue;
    if ((c.title || '').toLowerCase().includes(needle)) {
      hits.push({ ...meta, snippet: '' });
      continue;
    }
    for (const m of c.messages || []) {
      const t = textOf(m.content);
      const i = t.toLowerCase().indexOf(needle);
      if (i >= 0) {
        hits.push({ ...meta, snippet: t.slice(Math.max(0, i - 40), i + 90).replace(/\s+/g, ' ').trim() });
        break;
      }
    }
  }
  return hits;
}

function toMarkdown(chat) {
  const lines = [
    '# ' + (chat.title || 'Conversación'),
    '',
    `_Exportado de DEDLIT Studio — ${new Date(chat.updatedAt || Date.now()).toLocaleString('es-ES')}_`,
    ''
  ];
  for (const m of chat.messages || []) {
    if (m.role === 'system') continue;
    if (m.role === 'user') {
      lines.push('## 👤 Usuario', '', textOf(m.content), '');
    } else if (m.role === 'assistant') {
      const text = textOf(m.content);
      if (text) lines.push('## 🤖 Asistente', '', text, '');
      for (const tc of m.tool_calls || []) {
        lines.push('> 🔧 `' + tc.function.name + '` — `' + String(tc.function.arguments).slice(0, 300) + '`', '');
      }
      if (Array.isArray(m.content)) {
        for (const p of m.content) {
          if (p.type === 'image_url') lines.push('🖼️ imagen: `' + (p.image_url?.url || '') + '`', '');
          if (p.type === 'input_audio') lines.push('🎧 audio: `' + (p.input_audio?.data || '') + '`', '');
          if (p.type === 'video_url') lines.push('🎬 vídeo: `' + (p.video_url?.url || '') + '`', '');
        }
      }
    } else if (m.role === 'tool') {
      lines.push('<details><summary>🔧 Resultado</summary>', '', '```', textOf(m.content).slice(0, 4000), '```', '', '</details>', '');
    }
  }
  return lines.join('\n');
}

module.exports = { list, get, save, remove, search, toMarkdown };
