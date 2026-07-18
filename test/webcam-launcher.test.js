'use strict';
// Test de integración del lanzador de escritorio de DEDLIT Webcam: sirve el
// HTML y hace de proxy hacia la API de Stable Diffusion (sin CORS).
const http = require('node:http');

process.env.DEDLIT_SILENT = '1';
process.env.DEDLIT_WEBCAM_PORT = '8698';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const BASE = 'http://127.0.0.1:8698';
let mock, server;

before(async () => {
  // mock de A1111 (sin cabeceras CORS: el proxy debe hacerlas innecesarias)
  await new Promise(resolve => {
    mock = http.createServer((req, res) => {
      if (req.url === '/sdapi/v1/sd-models') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify([{ model_name: 'mock-sd' }]));
      }
      if (req.url === '/sdapi/v1/img2img') {
        let b = ''; req.on('data', c => b += c); req.on('end', () => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ images: [JSON.parse(b).init_images[0]] }));
        });
        return;
      }
      res.writeHead(404); res.end();
    });
    mock.listen(0, '127.0.0.1', resolve);
  });
  server = require('../standalone/webcam-launcher');
  await new Promise(r => (server.listening ? r() : server.on('listening', r)));
});

after(() => {
  try { server && server.close(); } catch {}
  try { mock && mock.close(); } catch {}
});

const sdUrl = () => 'http://127.0.0.1:' + mock.address().port;

test('sirve la app en /', async () => {
  const res = await fetch(BASE + '/');
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /DEDLIT Webcam/);
  assert.match(html, /CAM_EFFECTS/);
});

test('/sdproxy/ping responde (marcador de detección del proxy)', async () => {
  assert.equal((await fetch(BASE + '/sdproxy/ping')).status, 204);
});

test('sirve el SDK vendorizado de Lucy Realtime', async () => {
  const res = await fetch(BASE + '/decart-sdk.js');
  assert.equal(res.status, 200);
  assert.match(await res.text(), /DecartSDK/);
});

test('el proxy reenvía GET a la URL de x-sd-url', async () => {
  const r = await fetch(BASE + '/sdproxy/sdapi/v1/sd-models', { headers: { 'x-sd-url': sdUrl() } });
  assert.equal(r.status, 200);
  assert.equal((await r.json())[0].model_name, 'mock-sd');
});

test('el proxy reenvía POST con cuerpo (img2img)', async () => {
  const r = await fetch(BASE + '/sdproxy/sdapi/v1/img2img', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-sd-url': sdUrl() },
    body: JSON.stringify({ init_images: ['Zm9=='] })
  });
  assert.equal((await r.json()).images[0], 'Zm9==');
});

test('x-sd-url no válida devuelve 400', async () => {
  const r = await fetch(BASE + '/sdproxy/sdapi/v1/sd-models', { headers: { 'x-sd-url': 'ftp://nope' } });
  assert.equal(r.status, 400);
});

test('destino apagado devuelve 502 con mensaje', async () => {
  const r = await fetch(BASE + '/sdproxy/sdapi/v1/sd-models', { headers: { 'x-sd-url': 'http://127.0.0.1:1' } });
  assert.equal(r.status, 502);
  assert.match((await r.json()).error, /no responde/);
});
