'use strict';
// RAG local sin dependencias: indexa carpetas de documentos (texto, código,
// PDF y DOCX), genera embeddings con cualquier endpoint OpenAI-compatible
// (/v1/embeddings de LM Studio, Ollama, OpenAI…) y busca por similitud
// coseno. Las colecciones viven en ~/.dedlit/rag, una por archivo JSON.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const configLib = require('./config');
const providers = require('./providers');

const DIR = path.join(configLib.DIR, 'rag');

const TEXT_EXT = new Set([
  '.txt', '.md', '.markdown', '.rst', '.csv', '.log', '.ini', '.cfg', '.toml',
  '.js', '.mjs', '.ts', '.tsx', '.jsx', '.py', '.java', '.c', '.h', '.cpp', '.cs', '.rs', '.go', '.rb', '.php',
  '.html', '.css', '.json', '.yaml', '.yml', '.xml', '.sh', '.ps1', '.bat', '.sql'
]);
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.dedlit', '__pycache__', '.venv', 'venv']);

function ensure() {
  if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true });
}

function fileOf(id) {
  return path.join(DIR, String(id).replace(/[^\w-]/g, '') + '.json');
}

// ---------- Extracción de texto ----------

// PDF: extractor mínimo — infla los streams FlateDecode y recoge los
// operadores de texto Tj/TJ. Suficiente para PDFs de texto normales;
// los escaneados o con fuentes CID darán poco o nada.
function pdfToText(buf) {
  const raw = buf.toString('latin1');
  const out = [];
  const streamRe = /stream\r?\n/g;
  let m;
  while ((m = streamRe.exec(raw))) {
    const start = m.index + m[0].length;
    const end = raw.indexOf('endstream', start);
    if (end < 0) break;
    let data = buf.subarray(start, end);
    try { data = zlib.inflateSync(data); } catch { /* stream sin comprimir */ }
    const s = data.toString('latin1');
    if (!s.includes('Tj') && !s.includes('TJ')) continue;
    const tRe = /\(((?:\\.|[^\\()])*)\)/g;
    let t;
    let pieces = [];
    while ((t = tRe.exec(s))) {
      const txt = t[1]
        .replace(/\\([()\\])/g, '$1')
        .replace(/\\n/g, '\n').replace(/\\r/g, '').replace(/\\t/g, ' ')
        .replace(/\\(\d{1,3})/g, (_, o) => String.fromCharCode(parseInt(o, 8)));
      pieces.push(txt);
    }
    if (!pieces.length) continue;
    const joined = pieces.join(' ');
    // descartar streams con demasiados caracteres no imprimibles (fuentes CID)
    const printable = joined.replace(/[^\x20-\x7EáéíóúüñÁÉÍÓÚÜÑ¿¡€\n]/g, '');
    if (printable.length > joined.length * 0.6) out.push(printable);
  }
  return out.join('\n').replace(/[ \t]+/g, ' ').trim();
}

// DOCX: es un ZIP — se localiza word/document.xml en las cabeceras locales
// y se infla con inflateRaw; luego se quitan las etiquetas XML.
function docxToText(buf) {
  let off = 0;
  while (off < buf.length - 30 && buf.readUInt32LE(off) === 0x04034b50) {
    const method = buf.readUInt16LE(off + 8);
    const compSize = buf.readUInt32LE(off + 18);
    const nameLen = buf.readUInt16LE(off + 26);
    const extraLen = buf.readUInt16LE(off + 28);
    const name = buf.toString('utf8', off + 30, off + 30 + nameLen);
    const dataStart = off + 30 + nameLen + extraLen;
    if (name === 'word/document.xml' && compSize > 0) {
      const data = buf.subarray(dataStart, dataStart + compSize);
      const xml = (method === 8 ? zlib.inflateRawSync(data) : data).toString('utf8');
      return xml
        .replace(/<\/w:p>/g, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
        .replace(/[ \t]+/g, ' ').trim();
    }
    off = dataStart + compSize;
  }
  throw new Error('no se encontró word/document.xml');
}

function extractText(file) {
  const ext = path.extname(file).toLowerCase();
  const stat = fs.statSync(file);
  if (stat.size > 25 * 1024 * 1024) return null;
  if (ext === '.pdf') return pdfToText(fs.readFileSync(file));
  if (ext === '.docx') return docxToText(fs.readFileSync(file));
  if (TEXT_EXT.has(ext)) {
    const text = fs.readFileSync(file, 'utf8');
    return text.includes('\0') ? null : text;
  }
  return null;
}

function scanFolder(folder) {
  const files = [];
  const walk = (dir, depth) => {
    if (depth > 8 || files.length >= 2000) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (files.length >= 2000) return;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) walk(full, depth + 1);
      } else {
        const ext = path.extname(e.name).toLowerCase();
        if (ext === '.pdf' || ext === '.docx' || TEXT_EXT.has(ext)) files.push(full);
      }
    }
  };
  walk(folder, 0);
  return files;
}

// Troceado con solape: ventanas de ~1200 caracteres cada ~1000
function chunkText(text, file) {
  const chunks = [];
  const clean = text.replace(/\r/g, '');
  for (let i = 0; i < clean.length; i += 1000) {
    const piece = clean.slice(i, i + 1200).trim();
    if (piece.length > 40) chunks.push({ file, text: piece });
    if (chunks.length >= 400) break; // límite por archivo
  }
  return chunks;
}

// ---------- Índice ----------

async function buildIndex({ id, name, folder, provider, model, cfg, onProgress }) {
  ensure();
  if (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) {
    throw new Error('La carpeta no existe: ' + folder);
  }
  const files = scanFolder(folder);
  if (!files.length) throw new Error('No se encontraron documentos compatibles en ' + folder);

  const chunks = [];
  for (const f of files) {
    let text = null;
    try { text = extractText(f); } catch { /* archivo problemático */ }
    if (text) chunks.push(...chunkText(text, path.relative(folder, f)));
    if (chunks.length >= 8000) break; // límite global de la colección
  }
  if (!chunks.length) throw new Error('No se pudo extraer texto de ningún documento');

  // embeddings por lotes
  const BATCH = 24;
  for (let i = 0; i < chunks.length; i += BATCH) {
    const batch = chunks.slice(i, i + BATCH);
    const vectors = await providers.embed({ providerId: provider, model, texts: batch.map(c => c.text), cfg });
    if (vectors.length !== batch.length) throw new Error('El proveedor devolvió ' + vectors.length + ' embeddings para ' + batch.length + ' textos');
    batch.forEach((c, j) => { c.vector = vectors[j]; });
    if (onProgress) onProgress(Math.min(i + BATCH, chunks.length), chunks.length);
  }

  const collection = { id, name, folder, provider, model, createdAt: Date.now(), files: files.length, chunks };
  fs.writeFileSync(fileOf(id), JSON.stringify(collection));
  return { id, name, files: files.length, chunks: chunks.length };
}

function list() {
  ensure();
  const out = [];
  for (const f of fs.readdirSync(DIR)) {
    if (!f.endsWith('.json')) continue;
    try {
      const c = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
      out.push({ id: c.id, name: c.name, folder: c.folder, provider: c.provider, model: c.model, files: c.files, chunks: (c.chunks || []).length });
    } catch { /* corrupto */ }
  }
  return out;
}

function get(id) {
  try { return JSON.parse(fs.readFileSync(fileOf(id), 'utf8')); } catch { return null; }
}

function remove(id) {
  try { fs.unlinkSync(fileOf(id)); } catch { /* ya no existe */ }
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

async function search(id, query, cfg, k = 5) {
  const col = get(id);
  if (!col) throw new Error('Colección no encontrada: ' + id);
  const [qv] = await providers.embed({ providerId: col.provider, model: col.model, texts: [query], cfg });
  return col.chunks
    .map(c => ({ file: c.file, text: c.text, score: cosine(qv, c.vector) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map(r => ({ ...r, score: +r.score.toFixed(3), collection: col.name }));
}

async function searchAll(query, cfg, k = 5) {
  const results = [];
  for (const meta of list()) {
    try { results.push(...await search(meta.id, query, cfg, k)); } catch { /* colección con proveedor caído */ }
  }
  return results.sort((a, b) => b.score - a.score).slice(0, k);
}

module.exports = { list, get, remove, buildIndex, search, searchAll, _test: { chunkText, cosine, pdfToText, docxToText, extractText } };
