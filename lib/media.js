'use strict';
// Almacén local de medios (imágenes, audio, vídeo) en ~/.dedlit/media.
// En el historial de chat los adjuntos se guardan como referencias "media:archivo"
// (ligeras, aptas para localStorage); este módulo las resuelve a base64/data-URI
// justo antes de enviar al proveedor.

const fs = require('fs');
const path = require('path');
const configLib = require('./config');

const DIR = path.join(configLib.DIR, 'media');

const MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg', '.flac': 'audio/flac',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.mkv': 'video/x-matroska'
};

function ensure() {
  if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true });
}

function extFromMime(mime) {
  for (const [ext, m] of Object.entries(MIME)) if (m === mime) return ext;
  return '.bin';
}

function mimeOf(file) {
  return MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
}

function safeName(n) {
  return String(n || 'archivo').replace(/[^\w.\-]+/g, '_').slice(-60);
}

function saveDataUrl(dataUrl, name) {
  ensure();
  const m = /^data:([^;]+);base64,(.+)$/s.exec(dataUrl);
  if (!m) throw new Error('dataUrl inválido (se espera base64)');
  const mime = m[1];
  const buf = Buffer.from(m[2], 'base64');
  let file = Date.now().toString(36) + '-' + safeName(name || ('media' + extFromMime(mime)));
  if (!path.extname(file)) file += extFromMime(mime);
  fs.writeFileSync(path.join(DIR, file), buf);
  return { file, ref: 'media:' + file, url: '/media/' + file, mime, bytes: buf.length };
}

function saveBuffer(buf, ext, base) {
  ensure();
  const file = Date.now().toString(36) + '-' + base + ext;
  fs.writeFileSync(path.join(DIR, file), buf);
  return { file, ref: 'media:' + file, url: '/media/' + file, mime: mimeOf(file) };
}

function filePath(name) {
  return path.join(DIR, path.basename(name)); // basename evita path traversal
}

function refData(ref) {
  const file = ref.slice('media:'.length);
  return { buf: fs.readFileSync(filePath(file)), mime: mimeOf(file), file };
}

function toDataUri(ref) {
  const { buf, mime } = refData(ref);
  return `data:${mime};base64,${buf.toString('base64')}`;
}

// Prepara el historial para el proveedor:
//  - los mensajes marcados generated (imágenes/audio creados por la app) se
//    reducen a su texto, para no reenviar medios que el modelo de chat no acepta
//  - las referencias media: se resuelven a data-URIs / base64
function resolveMessages(messages) {
  return messages.map(m => {
    if (!Array.isArray(m.content)) return m;
    if (m.generated) {
      const text = m.content.filter(p => p.type === 'text').map(p => p.text).join('\n');
      return { role: m.role, content: text || '[contenido multimedia generado]' };
    }
    const content = m.content.map(p => {
      try {
        if (p.type === 'image_url' && p.image_url?.url?.startsWith('media:')) {
          return { type: 'image_url', image_url: { url: toDataUri(p.image_url.url) } };
        }
        if (p.type === 'input_audio' && p.input_audio?.data?.startsWith('media:')) {
          const { buf } = refData(p.input_audio.data);
          return { type: 'input_audio', input_audio: { data: buf.toString('base64'), format: p.input_audio.format || 'mp3' } };
        }
        if (p.type === 'video_url' && p.video_url?.url?.startsWith('media:')) {
          return { type: 'video_url', video_url: { url: toDataUri(p.video_url.url) } };
        }
      } catch (e) {
        return { type: 'text', text: '[adjunto no disponible: ' + e.message + ']' };
      }
      return p;
    });
    const msg = { role: m.role, content };
    if (m.tool_calls) msg.tool_calls = m.tool_calls;
    if (m.tool_call_id) msg.tool_call_id = m.tool_call_id;
    return msg;
  });
}

module.exports = { DIR, MIME, saveDataUrl, saveBuffer, filePath, mimeOf, refData, resolveMessages };
