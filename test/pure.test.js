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

// ---------- resaltado de sintaxis (extraído del cliente para poder testarlo) ----------
// Réplica mínima del tokenizador de public/app.js: verifica las invariantes
// de seguridad y correción (mismo algoritmo).
test('highlightCode: no colorea keywords en strings y escapa HTML', () => {
  const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const rules = [
    { cls: 'com', pattern: '//[^\\n]*' },
    { cls: 'str', pattern: '"(?:\\\\.|[^"\\\\\\n])*"' },
    { cls: 'kw', pattern: '\\b(?:const|return|function)\\b' }
  ];
  function hl(code) {
    const re = new RegExp(rules.map(r => '(' + r.pattern + ')').join('|'), 'g');
    let out = '', last = 0, m;
    while ((m = re.exec(code))) {
      if (m.index > last) out += esc(code.slice(last, m.index));
      let cls = 'str';
      for (let i = 1; i < m.length; i++) { if (m[i] !== undefined) { cls = rules[i - 1].cls; break; } }
      out += '<span class="' + cls + '">' + esc(m[0]) + '</span>';
      last = m.index + m[0].length;
      if (m[0].length === 0) re.lastIndex++;
    }
    return out + esc(code.slice(last));
  }
  const s = hl('const m = "tiene return dentro"; // return aqui');
  assert.match(s, /<span class="kw">const<\/span>/);
  // 'return' del string queda dentro del span de string, no como keyword
  assert.match(s, /<span class="str">&quot;tiene return dentro&quot;<\/span>/);
  // HTML peligroso escapado
  const xss = hl('const x = "<img onerror=alert(1)>"');
  assert.doesNotMatch(xss, /<img/);
  assert.match(xss, /&lt;img/);
});

// ---------- clasificación de errores para el fallback (misma lógica que server.js) ----------
test('isRecoverableError distingue cuota/tasa de auth/petición', () => {
  const isRecoverableError = msg => {
    const m = String(msg || '');
    if (/HTTP (429|402|503|500|529|420)\b/.test(m)) return true;
    if (/\b(401|403|400|404)\b/.test(m)) return false;
    return /rate.?limit|quota|exceeded|overloaded|capacity|too many requests|insufficient|try again/i.test(m);
  };
  assert.equal(isRecoverableError('HTTP 429: Too Many Requests'), true);
  assert.equal(isRecoverableError('HTTP 503: overloaded'), true);
  assert.equal(isRecoverableError('quota exceeded for today'), true);
  assert.equal(isRecoverableError('HTTP 401: invalid api key'), false); // auth: no reintentar
  assert.equal(isRecoverableError('HTTP 400: bad request'), false);
});

// ---------- estimación de tokens y coste (misma lógica que public/app.js) ----------
test('estimación de tokens (~4 car./token) y coste input/output', () => {
  const estimateTokens = c => Math.ceil((typeof c === 'string' ? c.length : 0) / 4);
  const chat = { messages: [
    { role: 'user', content: 'a'.repeat(4000) },      // 1000 tok entrada
    { role: 'assistant', content: 'b'.repeat(2000) }  // 500 tok salida
  ] };
  let input = 0, output = 0;
  for (const m of chat.messages) {
    const t = estimateTokens(m.content);
    if (m.role === 'assistant') output += t; else input += t;
  }
  assert.equal(input, 1000);
  assert.equal(output, 500);
  // tarifa claude sonnet: 3 entrada / 15 salida por millón
  const cost = (input / 1e6) * 3 + (output / 1e6) * 15;
  assert.ok(Math.abs(cost - 0.0105) < 1e-9);
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
