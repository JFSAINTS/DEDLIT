'use strict';
// DEDLIT Webcam — lanzador de escritorio. Sin dependencias: solo Node >= 18.
// Sirve dedlit-webcam.html en localhost, abre el navegador y hace de PROXY
// hacia la API de Stable Diffusion: así NO hace falta arrancar A1111 con
// --cors-allow-origins=* (la página y la API pasan a compartir origen).
// Se empaqueta como ejecutable con `npm run build:webcam` (dist/dedlit-webcam.exe).

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PORT = Number(process.env.DEDLIT_WEBCAM_PORT || 8645);
// path.join(__dirname, …) literales: pkg los detecta y empaqueta como assets
const HTML = path.join(__dirname, 'dedlit-webcam.html');
const DECART_SDK = path.join(__dirname, 'decart-sdk.js'); // SDK vendorizado de Lucy Realtime

// Proxy /sdproxy/<ruta> → <x-sd-url><ruta>. Solo destinos http(s); el binario
// escucha únicamente en 127.0.0.1, igual que el resto de DEDLIT.
function proxy(req, res, targetBase, targetPath) {
  let base;
  try {
    base = new URL(targetBase);
    if (base.protocol !== 'http:' && base.protocol !== 'https:') throw new Error('protocolo');
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end('{"error":"Cabecera x-sd-url no válida (debe ser una URL http/https)"}');
  }
  const mod = base.protocol === 'https:' ? https : http;
  const upstream = mod.request({
    hostname: base.hostname,
    port: base.port || (base.protocol === 'https:' ? 443 : 80),
    path: base.pathname.replace(/\/+$/, '') + targetPath,
    method: req.method,
    headers: { 'Content-Type': req.headers['content-type'] || 'application/json' },
    timeout: 300000
  }, up => {
    res.writeHead(up.statusCode, { 'Content-Type': up.headers['content-type'] || 'application/json' });
    up.pipe(res);
  });
  upstream.on('timeout', () => upstream.destroy(new Error('timeout')));
  upstream.on('error', err => {
    if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Stable Diffusion no responde en ' + targetBase + ' (' + err.message + ')' }));
  });
  req.pipe(upstream);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1:' + PORT);
  if (url.pathname === '/' || url.pathname === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return fs.createReadStream(HTML).pipe(res);
  }
  if (url.pathname === '/decart-sdk.js') {
    if (!fs.existsSync(DECART_SDK)) { res.writeHead(404); return res.end('404'); }
    res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'max-age=86400' });
    return fs.createReadStream(DECART_SDK).pipe(res);
  }
  if (url.pathname === '/sdproxy/ping') {
    res.writeHead(204);
    return res.end();
  }
  if (url.pathname.startsWith('/sdproxy/')) {
    return proxy(req, res, req.headers['x-sd-url'] || 'http://127.0.0.1:7860', url.pathname.slice('/sdproxy'.length) + url.search);
  }
  res.writeHead(404);
  res.end('404');
});

function openBrowser(u) {
  const cmd = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', u]]
    : process.platform === 'darwin' ? ['open', [u]]
    : ['xdg-open', [u]];
  try {
    spawn(cmd[0], cmd[1], { detached: true, stdio: 'ignore' }).unref();
  } catch { /* sin navegador: la URL queda impresa en consola */ }
}

server.listen(PORT, '127.0.0.1', () => {
  const u = 'http://127.0.0.1:' + PORT;
  if (!process.env.DEDLIT_SILENT) {
    console.log('');
    console.log('  🎥 DEDLIT Webcam');
    console.log('  ----------------');
    console.log('  Abierto en ' + u + '  (deja esta ventana en segundo plano)');
    console.log('  Restilizado IA: arranca Stable Diffusion WebUI con --api (sin flags CORS:');
    console.log('  este lanzador hace de proxy). Ctrl+C para salir.');
    console.log('');
    openBrowser(u);
  }
});

module.exports = server; // handle para tests de integración
