'use strict';
// Tests del RAG: extractores de PDF/DOCX (con fixtures generadas sin deps) e
// indexado + búsqueda semántica contra un mock de embeddings.
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const http = require('node:http');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dedlit-rag-'));
process.env.USERPROFILE = TMP;
process.env.HOME = TMP;

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const rag = require('../lib/rag');
const configLib = require('../lib/config');

// --- fixtures ---
function makePdf(texto) {
  const content = `BT /F1 12 Tf 72 720 Td (${texto}) Tj ET`;
  return Buffer.from([
    '%PDF-1.4',
    '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj',
    '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj',
    '3 0 obj << /Type /Page /Parent 2 0 R /Contents 4 0 R >> endobj',
    `4 0 obj << /Length ${content.length} >>`,
    'stream', content, 'endstream', 'endobj',
    'trailer << /Root 1 0 R >>'
  ].join('\n'), 'latin1');
}

// DOCX mínimo: ZIP (una entrada word/document.xml, deflate crudo). docxToText
// lee las cabeceras locales secuencialmente, así que no hace falta el índice.
function makeDocx(texto) {
  const xml = Buffer.from(`<w:document><w:body><w:p><w:t>${texto}</w:t></w:p></w:body></w:document>`, 'utf8');
  const comp = zlib.deflateRawSync(xml);
  const name = Buffer.from('word/document.xml', 'utf8');
  const h = Buffer.alloc(30);
  h.writeUInt32LE(0x04034b50, 0);   // firma local
  h.writeUInt16LE(20, 4);           // versión
  h.writeUInt16LE(0, 6);            // flags
  h.writeUInt16LE(8, 8);            // método = deflate
  h.writeUInt32LE(0, 14);           // crc (no verificado)
  h.writeUInt32LE(comp.length, 18); // tamaño comprimido
  h.writeUInt32LE(xml.length, 22);  // tamaño original
  h.writeUInt16LE(name.length, 26); // longitud del nombre
  h.writeUInt16LE(0, 28);           // extra
  return Buffer.concat([h, name, comp]);
}

let docsDir;
before(() => {
  docsDir = path.join(TMP, 'docs');
  fs.mkdirSync(docsDir, { recursive: true });
  fs.writeFileSync(path.join(docsDir, 'nota.txt'), 'El servidor de produccion se llama ATLAS y escucha en el puerto 9090.');
  fs.writeFileSync(path.join(docsDir, 'manual.pdf'), makePdf('La clave secreta del proyecto es DEDLIT cuarenta y dos.'));
  fs.writeFileSync(path.join(docsDir, 'receta.docx'), makeDocx('El gazpacho lleva tomate pepino y aceite de oliva.'));
});

after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} });

test('pdfToText extrae el texto de un PDF simple', () => {
  const t = rag._test.pdfToText(makePdf('Hola desde un PDF de prueba.'));
  assert.match(t, /Hola desde un PDF de prueba/);
});

test('docxToText extrae el texto de un DOCX', () => {
  const t = rag._test.docxToText(makeDocx('Contenido de Word aqui.'));
  assert.match(t, /Contenido de Word aqui/);
});

test('extractText despacha por extensión (txt/pdf/docx)', () => {
  assert.match(rag._test.extractText(path.join(docsDir, 'nota.txt')), /ATLAS/);
  assert.match(rag._test.extractText(path.join(docsDir, 'manual.pdf')), /clave secreta/);
  assert.match(rag._test.extractText(path.join(docsDir, 'receta.docx')), /gazpacho/);
});

// --- indexado + búsqueda con embeddings simulados (bolsa de palabras) ---
let mock, base;
before(async () => {
  mock = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      const { input } = JSON.parse(body);
      const texts = Array.isArray(input) ? input : [input];
      const embed = t => {
        const v = new Array(64).fill(0);
        for (const w of String(t).toLowerCase().match(/[a-záéíóúñ0-9]+/g) || []) {
          let h = 0; for (let i = 0; i < w.length; i++) h = (h * 31 + w.charCodeAt(i)) >>> 0;
          v[h % 64] += 1;
        }
        const n = Math.sqrt(v.reduce((a, x) => a + x * x, 0)) || 1;
        return v.map(x => x / n);
      };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: texts.map((t, index) => ({ index, embedding: embed(t) })) }));
    });
  });
  await new Promise(r => mock.listen(0, '127.0.0.1', r));
  base = 'http://127.0.0.1:' + mock.address().port + '/v1';
  const cfg = configLib.load();
  cfg.baseUrls.lmstudio = base;
  configLib.save(cfg);
});
after(() => mock && mock.close());

test('buildIndex indexa la carpeta y search recupera el documento correcto', async () => {
  const cfg = configLib.load();
  const res = await rag.buildIndex({ id: 'col1', name: 'Docs', folder: docsDir, provider: 'lmstudio', model: 'mock-embed', cfg });
  assert.equal(res.files, 3);
  assert.ok(res.chunks >= 3);

  const hits = await rag.search('col1', 'cual es la clave secreta del proyecto', cfg, 3);
  assert.equal(hits[0].file, 'manual.pdf'); // el fragmento más afín viene del PDF
  assert.ok(hits[0].score > 0);
});
