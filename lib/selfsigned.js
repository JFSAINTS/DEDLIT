'use strict';
// Generación de certificado X.509 autofirmado SIN dependencias: codificador
// ASN.1/DER mínimo + clave RSA de node:crypto. Se usa para el acceso LAN por
// HTTPS (cifra la contraseña en tránsito dentro de la red). El navegador
// avisará de "certificado no confiable" la primera vez, como los routers.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const configLib = require('./config');

// ---------- codificador DER ----------
function len(n) {
  if (n < 0x80) return Buffer.from([n]);
  const bytes = [];
  while (n > 0) { bytes.unshift(n & 0xff); n >>= 8; }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}
function tlv(tag, content) { return Buffer.concat([Buffer.from([tag]), len(content.length), content]); }
function seq(...items) { return tlv(0x30, Buffer.concat(items)); }
function set(item) { return tlv(0x31, item); }
function int(buf) {
  if (typeof buf === 'number') { buf = Buffer.from([buf]); }
  if (buf[0] & 0x80) buf = Buffer.concat([Buffer.from([0]), buf]); // positivo
  return tlv(0x02, buf);
}
function oid(str) {
  const parts = str.split('.').map(Number);
  const first = 40 * parts[0] + parts[1];
  const bytes = [first];
  for (let i = 2; i < parts.length; i++) {
    let v = parts[i];
    const stack = [v & 0x7f];
    v >>= 7;
    while (v > 0) { stack.unshift((v & 0x7f) | 0x80); v >>= 7; }
    bytes.push(...stack);
  }
  return tlv(0x06, Buffer.from(bytes));
}
function nullTlv() { return Buffer.from([0x05, 0x00]); }
function bitString(buf) { return tlv(0x03, Buffer.concat([Buffer.from([0]), buf])); }
function octetString(buf) { return tlv(0x04, buf); }
function utf8(str) { return tlv(0x0c, Buffer.from(str, 'utf8')); }
function ctx(n, content, constructed = true) { return tlv((constructed ? 0xa0 : 0x80) | n, content); }
function utcTime(date) {
  const s = date.toISOString().replace(/[-:T]/g, '').slice(2, 14) + 'Z'; // YYMMDDHHMMSSZ
  return tlv(0x17, Buffer.from(s));
}

function algId(oidStr) { return seq(oid(oidStr), nullTlv()); }
function name(cn) { return seq(set(seq(oid('2.5.4.3'), utf8(cn)))); } // CN

// subjectAltName: IPs (tag [7], 4 bytes) y DNS (tag [2])
function san(hosts) {
  const names = hosts.map(h => {
    const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(h);
    if (m) return tlv(0x87, Buffer.from(m.slice(1).map(Number))); // iPAddress
    return tlv(0x82, Buffer.from(h)); // dNSName
  });
  const value = octetString(seq(...names));
  return seq(oid('2.5.29.17'), value); // extnID + extnValue
}
function basicConstraints() {
  return seq(oid('2.5.29.19'), Buffer.from([0x01, 0x01, 0xff]), octetString(seq())); // CA:FALSE (crítica omitida)
}

// ---------- generación ----------
function generate(hosts) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const spki = publicKey.export({ type: 'spki', format: 'der' }); // = SubjectPublicKeyInfo

  const now = new Date();
  const notBefore = new Date(now.getTime() - 24 * 3600 * 1000);
  const notAfter = new Date(now.getTime() + 3650 * 24 * 3600 * 1000); // 10 años
  const sigAlg = algId('1.2.840.113549.1.1.11'); // sha256WithRSAEncryption
  const serial = int(crypto.randomBytes(8));

  const extensions = ctx(3, seq(san(hosts))); // [3] EXPLICIT SEQUENCE OF Extension
  const tbs = seq(
    ctx(0, int(2)),                 // version v3
    serial,
    sigAlg,
    name('DEDLIT Studio'),          // issuer
    seq(utcTime(notBefore), utcTime(notAfter)),
    name('DEDLIT Studio'),          // subject (autofirmado)
    spki,
    extensions
  );

  const signature = crypto.sign('sha256', tbs, privateKey);
  const cert = seq(tbs, sigAlg, bitString(signature));

  const toPem = (der, label) =>
    `-----BEGIN ${label}-----\n${der.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END ${label}-----\n`;

  return {
    cert: toPem(cert, 'CERTIFICATE'),
    key: privateKey.export({ type: 'pkcs8', format: 'pem' })
  };
}

// Carga desde ~/.dedlit o genera si no existe / cambian los hosts
function ensure(hosts) {
  const dir = configLib.DIR;
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const certPath = path.join(dir, 'lan-cert.pem');
  const keyPath = path.join(dir, 'lan-key.pem');
  const metaPath = path.join(dir, 'lan-cert.hosts');
  const wanted = hosts.join(',');
  try {
    if (fs.existsSync(certPath) && fs.existsSync(keyPath) && fs.readFileSync(metaPath, 'utf8') === wanted) {
      return { cert: fs.readFileSync(certPath, 'utf8'), key: fs.readFileSync(keyPath, 'utf8') };
    }
  } catch { /* regenerar */ }
  const pair = generate(hosts);
  fs.writeFileSync(certPath, pair.cert);
  fs.writeFileSync(keyPath, pair.key);
  fs.writeFileSync(metaPath, wanted);
  return pair;
}

module.exports = { generate, ensure };
