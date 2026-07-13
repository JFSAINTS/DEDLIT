'use strict';
// Test del generador de certificados autofirmados (ASN.1/DER sin deps).
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dedlit-cert-'));
process.env.USERPROFILE = TMP;
process.env.HOME = TMP;

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const https = require('node:https');
const selfsigned = require('../lib/selfsigned');

after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} });

test('genera un certificado X.509 parseable con los SAN pedidos', () => {
  const { cert, key } = selfsigned.generate(['127.0.0.1', '192.168.1.50', 'localhost']);
  const x = new crypto.X509Certificate(cert); // lanza si el DER está mal
  assert.match(x.subject, /DEDLIT Studio/);
  assert.match(x.subjectAltName, /127\.0\.0\.1/);
  assert.match(x.subjectAltName, /192\.168\.1\.50/);
  assert.match(x.subjectAltName, /localhost/);
  assert.match(key, /BEGIN PRIVATE KEY/);
});

test('el certificado sirve una conexión HTTPS real', async () => {
  const { cert, key } = selfsigned.generate(['127.0.0.1', 'localhost']);
  const srv = https.createServer({ key, cert }, (req, res) => res.end('ok-tls'));
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  const body = await new Promise((resolve, reject) => {
    https.get({ host: '127.0.0.1', port, path: '/', rejectUnauthorized: false }, r => {
      let d = ''; r.on('data', c => d += c); r.on('end', () => resolve(d));
    }).on('error', reject);
  });
  srv.close();
  assert.equal(body, 'ok-tls');
});

test('ensure reutiliza el certificado si los hosts no cambian', () => {
  const a = selfsigned.ensure(['127.0.0.1', 'localhost']);
  const b = selfsigned.ensure(['127.0.0.1', 'localhost']);
  assert.equal(a.cert, b.cert); // mismo cert cacheado en disco
  const c = selfsigned.ensure(['127.0.0.1', '10.0.0.5']); // hosts distintos → regenera
  assert.notEqual(a.cert, c.cert);
});
