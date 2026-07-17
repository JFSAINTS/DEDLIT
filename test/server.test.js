'use strict';
// Test de integración: arranca el servidor real contra un proveedor simulado
// y ejercita los endpoints principales (config, status, gateway /v1, chat SSE,
// CRUD de chats). Home y puerto aislados.
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dedlit-srv-'));
process.env.USERPROFILE = TMP;
process.env.HOME = TMP;
process.env.DEDLIT_SILENT = '1';
process.env.DEDLIT_PORT = '8699';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const configLib = require('../lib/config');

const BASE = 'http://127.0.0.1:8699';
let mock, server;

// Mock de proveedor OpenAI-compatible
function startMock() {
  return new Promise(resolve => {
    mock = http.createServer((req, res) => {
      if (req.url === '/v1/models') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ data: [{ id: 'mock' }] }));
      }
      if (req.url === '/v1/chat/completions') {
        let b = ''; req.on('data', c => b += c); req.on('end', () => {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'hola desde el mock' } }] }) + '\n\n');
          res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + '\n\n');
          res.write('data: [DONE]\n\n');
          res.end();
        });
        return;
      }
      if (req.url === '/sdapi/v1/sd-models') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify([{ model_name: 'mock-sd' }]));
      }
      if (req.url === '/sdapi/v1/img2img') {
        let b = ''; req.on('data', c => b += c); req.on('end', () => {
          const body = JSON.parse(b);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          // devuelve el mismo init_image: suficiente para verificar el circuito
          res.end(JSON.stringify({ images: [body.init_images[0]] }));
        });
        return;
      }
      res.writeHead(404); res.end();
    });
    mock.listen(0, '127.0.0.1', () => resolve());
  });
}

async function waitReady() {
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(BASE + '/api/config')).ok) return; } catch {}
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error('el servidor no arrancó');
}

before(async () => {
  await startMock();
  // pre-sembrar la config para que "lmstudio" apunte al mock
  const cfg = configLib.load();
  cfg.baseUrls.lmstudio = 'http://127.0.0.1:' + mock.address().port + '/v1';
  cfg.sdWebuiUrl = 'http://127.0.0.1:' + mock.address().port; // el mock también hace de SD WebUI
  configLib.save(cfg);
  server = require('../server'); // efecto secundario: empieza a escuchar
  await waitReady();
});

after(() => {
  try { server && server.close(); } catch {}
  try { mock && mock.close(); } catch {}
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
});

test('GET /api/config expone proveedores y versión', async () => {
  const c = await (await fetch(BASE + '/api/config')).json();
  assert.ok(Object.keys(c.providers).length >= 15);
  assert.match(c.version, /^\d+\.\d+\.\d+/);
  assert.ok('lmstudio' in c.providers);
});

test('GET /api/status devuelve los 4 servidores locales', async () => {
  const s = await (await fetch(BASE + '/api/status')).json();
  for (const k of ['ollama', 'lmstudio', 'sd', 'comfy']) assert.ok(k in s);
  assert.equal(s.lmstudio.online, true); // apunta al mock, que responde /v1/models
});

test('GET /v1/models lista modelos en formato proveedor:modelo', async () => {
  const m = await (await fetch(BASE + '/v1/models')).json();
  assert.equal(m.object, 'list');
  assert.ok(m.data.some(x => x.id === 'lmstudio:mock'));
});

test('POST /v1/chat/completions (gateway no-streaming) responde', async () => {
  const r = await (await fetch(BASE + '/v1/chat/completions', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'lmstudio:mock', messages: [{ role: 'user', content: 'hey' }] })
  })).json();
  assert.match(r.choices[0].message.content, /hola desde el mock/);
});

test('POST /api/chat emite SSE con texto y done', async () => {
  const res = await fetch(BASE + '/api/chat', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: 'lmstudio', model: 'mock', messages: [{ role: 'user', content: 'hey' }] })
  });
  const text = await res.text();
  assert.match(text, /"type":"text"/);
  assert.match(text, /hola desde el mock/);
  assert.match(text, /"type":"done"/);
});

test('CRUD de /api/chats', async () => {
  const saved = await (await fetch(BASE + '/api/chats', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat: { title: 'Prueba', messages: [{ role: 'user', content: 'hola' }] } })
  })).json();
  assert.ok(saved.id);
  const list = await (await fetch(BASE + '/api/chats')).json();
  assert.ok(list.chats.some(c => c.id === saved.id));
  await fetch(BASE + '/api/chats/' + saved.id, { method: 'DELETE' });
  const list2 = await (await fetch(BASE + '/api/chats')).json();
  assert.ok(!list2.chats.some(c => c.id === saved.id));
});

test('GET /api/cam/status detecta el backend de restilizado', async () => {
  const s = await (await fetch(BASE + '/api/cam/status')).json();
  assert.equal(s.backend, 'sd');
  assert.equal(s.ipAdapter, null); // el mock no tiene ControlNet
});

test('POST /api/cam/restyle restiliza un fotograma vía img2img', async () => {
  const b64 = Buffer.from('fotograma-de-prueba').toString('base64');
  const r = await (await fetch(BASE + '/api/cam/restyle', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image: 'data:image/jpeg;base64,' + b64, prompt: 'anime style', denoise: 0.5, steps: 10 })
  })).json();
  assert.equal(r.backend, 'sd');
  assert.equal(r.image, 'data:image/png;base64,' + b64); // el mock devuelve el mismo fotograma
});

test('POST /api/cam/restyle sin imagen devuelve 400', async () => {
  const res = await fetch(BASE + '/api/cam/restyle', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: 'x' })
  });
  assert.equal(res.status, 400);
});

test('rechaza chat con parámetros faltantes', async () => {
  const res = await fetch(BASE + '/api/chat', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: 'lmstudio' }) // sin model ni messages
  });
  assert.equal(res.status, 400);
});
