'use strict';
// Tests de persistencia en disco (config cifrada, chats). Aísla ~/.dedlit
// redirigiendo el home a una carpeta temporal ANTES de cargar los módulos.
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dedlit-test-'));
process.env.USERPROFILE = TMP; // Windows
process.env.HOME = TMP;        // Unix/macOS

const { test, after } = require('node:test');
const assert = require('node:assert/strict');

const configLib = require('../lib/config');
const chats = require('../lib/chats');

after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} });

// ---------- config: cifrado de API keys ----------
test('las API keys hacen round-trip cifrado y no quedan en claro', () => {
  const cfg = configLib.load();
  const secreto = 'sk-super-secreta-12345';
  configLib.setKey(cfg, 'openai', secreto);
  configLib.save(cfg);

  // en disco debe estar cifrado (iv/tag/data), nunca el texto plano
  const raw = fs.readFileSync(path.join(configLib.DIR, 'config.json'), 'utf8');
  assert.doesNotMatch(raw, /sk-super-secreta/);
  assert.match(raw, /"iv"/);

  // al recargar se descifra correctamente
  const cfg2 = configLib.load();
  assert.equal(configLib.getKey(cfg2, 'openai'), secreto);
});

test('setKey con vacío borra la clave', () => {
  const cfg = configLib.load();
  configLib.setKey(cfg, 'openai', 'algo');
  configLib.setKey(cfg, 'openai', '');
  assert.equal(configLib.getKey(cfg, 'openai'), '');
});

test('load aplica los valores por defecto', () => {
  const cfg = configLib.load();
  assert.equal(cfg.autoApprove.read, true);
  assert.equal(cfg.autoApprove.command, false);
  assert.ok(Array.isArray(cfg.projects));
});

// ---------- chats: CRUD, búsqueda, exportación, caché ----------
test('save/get/list mantienen el chat y la caché de metadatos', () => {
  const id = chats.save({ title: 'Hola mundo', messages: [{ role: 'user', content: 'qué tal' }] });
  const got = chats.get(id);
  assert.equal(got.title, 'Hola mundo');
  const meta = chats.list().find(c => c.id === id);
  assert.equal(meta.count, 1);
});

test('search encuentra por título y por contenido con fragmento', () => {
  chats.save({ id: 'c-busqueda', title: 'Notas', messages: [
    { role: 'user', content: 'la clave del proyecto es azul' }
  ] });
  const porContenido = chats.search('azul');
  assert.ok(porContenido.some(r => r.id === 'c-busqueda'));
  assert.match(porContenido.find(r => r.id === 'c-busqueda').snippet, /azul/);
  assert.ok(chats.search('Notas').some(r => r.id === 'c-busqueda')); // por título
});

test('toMarkdown exporta roles y herramientas', () => {
  const md = chats.toMarkdown({ title: 'Export', updatedAt: Date.now(), messages: [
    { role: 'user', content: 'pregunta' },
    { role: 'assistant', content: 'respuesta', tool_calls: [{ id: 'x', function: { name: 'run_command', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'x', content: 'salida' }
  ] });
  assert.match(md, /# Export/);
  assert.match(md, /Usuario/);
  assert.match(md, /run_command/);
});

test('remove borra del disco y de la caché', () => {
  const id = chats.save({ title: 'Temporal', messages: [{ role: 'user', content: 'x' }] });
  chats.remove(id);
  assert.equal(chats.get(id), null);
  assert.ok(!chats.list().some(c => c.id === id));
});
