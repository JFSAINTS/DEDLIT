'use strict';
// Tests unitarios de lógica pura (sin red ni disco). Runner nativo de Node.
const { test } = require('node:test');
const assert = require('node:assert/strict');

const updater = require('../lib/updater');
const providers = require('../lib/providers');
const agent = require('../lib/agent');
const rag = require('../lib/rag');
const system = require('../lib/system');
const media = require('../lib/media');

// ---------- updater: comparación de versiones ----------
test('cmpVer ordena versiones semánticas', () => {
  assert.equal(updater.cmpVer('1.2.0', '1.1.9'), 1);
  assert.equal(updater.cmpVer('1.0.0', '1.0.1'), -1);
  assert.equal(updater.cmpVer('2.0.0', '2.0.0'), 0);
  assert.equal(updater.cmpVer('v1.10.0', 'v1.9.0'), 1); // 10 > 9 numérico, no lexicográfico
  assert.equal(updater.cmpVer('1.0', '1.0.0'), 0);      // faltantes = 0
});

test('assetName coincide con la plataforma actual', () => {
  const name = updater._test.assetName();
  const esperado = process.platform === 'win32' ? 'dedlit-studio-win-x64.exe'
    : process.platform === 'darwin' ? (process.arch === 'arm64' ? 'dedlit-studio-macos-arm64' : 'dedlit-studio-macos-x64')
    : 'dedlit-studio-linux-x64';
  assert.equal(name, esperado);
});

// ---------- providers: normalización de URL y adaptador Anthropic ----------
test('baseUrl normaliza localhost a 127.0.0.1 y respeta overrides', () => {
  const cfg = { baseUrls: {} };
  assert.equal(providers._test.baseUrl('ollama', cfg), 'http://127.0.0.1:11434/v1');
  const cfg2 = { baseUrls: { lmstudio: 'http://localhost:1234/v1/' } };
  assert.equal(providers._test.baseUrl('lmstudio', cfg2), 'http://127.0.0.1:1234/v1');
});

test('toAnthropicMessages separa system, fusiona tool_result y convierte imágenes', () => {
  const { system: sys, messages } = providers._test.toAnthropicMessages([
    { role: 'system', content: 'sé breve' },
    { role: 'user', content: [
      { type: 'text', text: 'mira' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } }
    ] },
    { role: 'assistant', content: 'ok', tool_calls: [{ id: 't1', function: { name: 'f', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 't1', content: 'resultado' }
  ]);
  assert.equal(sys, 'sé breve');
  // user con texto + imagen
  const img = messages[0].content.find(c => c.type === 'image');
  assert.equal(img.source.media_type, 'image/png');
  assert.equal(img.source.data, 'QUJD');
  // assistant con tool_use
  assert.equal(messages[1].content.find(c => c.type === 'tool_use').name, 'f');
  // tool_result vuelve como user
  assert.equal(messages[2].content[0].type, 'tool_result');
  assert.equal(messages[2].content[0].tool_use_id, 't1');
});

// ---------- agent: helpers ----------
test('htmlToText limpia etiquetas y decodifica entidades', () => {
  const t = agent._test.htmlToText('<p>Hola&nbsp;<b>mundo</b></p><script>malo()</script><div>fin&amp;</div>');
  assert.match(t, /Hola mundo/);
  assert.match(t, /fin&/);
  assert.doesNotMatch(t, /malo|script/);
});

test('globToRegex convierte comodines', () => {
  assert.ok(agent._test.globToRegex('*.js').test('app.js'));
  assert.ok(!agent._test.globToRegex('*.js').test('app.ts'));
  assert.ok(agent._test.globToRegex('test_?.py').test('test_1.py'));
});

// ---------- rag: coseno y troceado ----------
test('cosine da 1 a vectores iguales y ~0 a ortogonales', () => {
  assert.ok(Math.abs(rag._test.cosine([1, 2, 3], [1, 2, 3]) - 1) < 1e-9);
  assert.ok(Math.abs(rag._test.cosine([1, 0], [0, 1])) < 1e-9);
});

test('chunkText trocea con solape y descarta trozos minúsculos', () => {
  const txt = 'a'.repeat(2500);
  const chunks = rag._test.chunkText(txt, 'x.txt');
  assert.ok(chunks.length >= 2);
  assert.ok(chunks.every(c => c.file === 'x.txt'));
  assert.equal(rag._test.chunkText('   corto   ', 'y.txt').length, 0); // <40 chars útiles
});

// ---------- system: semáforo ----------
test('verdict clasifica verde/amarillo/rojo', () => {
  const gpu = { ramGB: 16, totalVramGB: 8, unified: false };
  assert.equal(system.verdict(2 * 1073741824, gpu).level, 'green');   // ~3.8 GB <= 8
  assert.equal(system.verdict(10 * 1073741824, gpu).level, 'yellow'); // ~13 GB, cabe en 16*.85+8
  assert.equal(system.verdict(40 * 1073741824, gpu).level, 'red');    // ~47 GB, no cabe
  const cpuOnly = { ramGB: 16, totalVramGB: 0, unified: false };
  assert.equal(system.verdict(2 * 1073741824, cpuOnly).level, 'yellow'); // sin GPU nunca es verde
});

// ---------- media ----------
test('mimeOf reconoce extensiones', () => {
  assert.equal(media.mimeOf('foto.png'), 'image/png');
  assert.equal(media.mimeOf('a.MP3'), 'audio/mpeg');
  assert.equal(media.mimeOf('clip.webm'), 'video/webm');
  assert.equal(media.mimeOf('raro.xyz'), 'application/octet-stream');
});

test('resolveMessages reduce mensajes generados a texto', () => {
  const out = media.resolveMessages([
    { role: 'assistant', generated: true, content: [
      { type: 'text', text: 'Imagen generada' },
      { type: 'image_url', image_url: { url: 'media:img.png' } }
    ] }
  ]);
  assert.equal(out[0].content, 'Imagen generada'); // sin binario reenviado
});
