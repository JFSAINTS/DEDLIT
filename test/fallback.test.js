'use strict';
// Test del fallback entre proveedores: un mock que da 429 en un puerto y
// responde bien en otro; se configura la ranura "lmstudio" (429) con reserva
// a "openai" (ok) y se comprueba que /api/chat cae al segundo.
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dedlit-fb-'));
process.env.USERPROFILE = TMP;
process.env.HOME = TMP;
process.env.DEDLIT_SILENT = '1';
process.env.DEDLIT_PORT = '8695';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const configLib = require('../lib/config');

const BASE = 'http://127.0.0.1:8695';
let failMock, okMock, server;

function sse(res, o) { res.write('data: ' + JSON.stringify(o) + '\n\n'); }

// mock que siempre devuelve 429 (rate limit) en /chat/completions
function startFail() {
  return new Promise(r => {
    failMock = http.createServer((req, res) => {
      if (req.url === '/v1/models') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end('{"data":[{"id":"m"}]}'); }
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end('{"error":{"message":"Rate limit reached"}}');
    });
    failMock.listen(0, '127.0.0.1', r);
  });
}
// mock que responde bien por SSE
function startOk() {
  return new Promise(r => {
    okMock = http.createServer((req, res) => {
      if (req.url === '/v1/models') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end('{"data":[{"id":"m"}]}'); }
      let b = ''; req.on('data', c => b += c); req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        sse(res, { choices: [{ delta: { content: 'respuesta del reserva' } }] });
        sse(res, { choices: [{ delta: {}, finish_reason: 'stop' }] });
        res.write('data: [DONE]\n\n'); res.end();
      });
    });
    okMock.listen(0, '127.0.0.1', r);
  });
}

async function waitReady() {
  for (let i = 0; i < 100; i++) { try { if ((await fetch(BASE + '/api/config')).ok) return; } catch {} await new Promise(r => setTimeout(r, 50)); }
  throw new Error('servidor no arrancó');
}

before(async () => {
  await startFail(); await startOk();
  const cfg = configLib.load();
  cfg.baseUrls.lmstudio = 'http://127.0.0.1:' + failMock.address().port + '/v1'; // principal → 429
  cfg.baseUrls.openai = 'http://127.0.0.1:' + okMock.address().port + '/v1';     // reserva → ok
  cfg.fallbackChain = ['openai:m'];
  configLib.save(cfg);
  server = require('../server');
  await waitReady();
});

after(() => {
  try { server.close(); } catch {}
  try { failMock.close(); okMock.close(); } catch {}
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
});

test('cae al proveedor de reserva cuando el principal da 429', async () => {
  const res = await fetch(BASE + '/api/chat', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: 'lmstudio', model: 'm', messages: [{ role: 'user', content: 'hola' }] })
  });
  const text = await res.text();
  assert.match(text, /"type":"fallback"/);          // avisó del cambio
  assert.match(text, /"provider":"openai"/);
  assert.match(text, /respuesta del reserva/);       // usó el reserva
  assert.doesNotMatch(text, /"type":"error"/);       // no acabó en error
});

test('sin cadena de reserva, un 429 se propaga como error', async () => {
  const cfg = configLib.load();
  cfg.fallbackChain = [];
  configLib.save(cfg);
  const res = await fetch(BASE + '/api/chat', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: 'lmstudio', model: 'm', messages: [{ role: 'user', content: 'hola' }] })
  });
  const text = await res.text();
  assert.match(text, /"type":"error"/);
  assert.doesNotMatch(text, /"type":"fallback"/);
});
