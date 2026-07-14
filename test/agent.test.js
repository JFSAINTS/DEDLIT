'use strict';
// Tests de agent.js: carga de knowledge del workspace y menciones @archivo.
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dedlit-agent-'));
process.env.USERPROFILE = TMP;
process.env.HOME = TMP;

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const agent = require('../lib/agent');

let ws;
before(() => {
  ws = path.join(TMP, 'proyecto');
  fs.mkdirSync(path.join(ws, 'src'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'AGENTS.md'), 'Convención: usa 2 espacios de indentación.');
  fs.writeFileSync(path.join(ws, 'src', 'util.js'), 'export const suma = (a, b) => a + b;');
  fs.writeFileSync(path.join(TMP, 'secreto.txt'), 'FUERA DEL WORKSPACE');
});
after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} });

test('systemPrompt incluye el knowledge del workspace (AGENTS.md)', () => {
  const p = agent.systemPrompt(ws);
  assert.match(p, /Contexto del proyecto/);
  assert.match(p, /2 espacios de indentación/);
  assert.match(p, /=== AGENTS\.md ===/);
});

test('systemPrompt sin archivos de conocimiento no añade el bloque', () => {
  const vacio = path.join(TMP, 'vacio');
  fs.mkdirSync(vacio, { recursive: true });
  assert.doesNotMatch(agent.systemPrompt(vacio), /Contexto del proyecto/);
});

test('expandMentions incluye el contenido del archivo citado', () => {
  const out = agent.expandMentions('revisa @src/util.js por favor', ws);
  assert.match(out, /=== src\/util\.js ===/);
  assert.match(out, /const suma/);
});

test('expandMentions ignora rutas fuera del workspace (path traversal)', () => {
  const out = agent.expandMentions('mira @../secreto.txt', ws);
  assert.doesNotMatch(out, /FUERA DEL WORKSPACE/);
  assert.equal(out, ''); // nada válido → bloque vacío
});

test('expandMentions ignora menciones que no son archivos', () => {
  assert.equal(agent.expandMentions('hola @juan y @noexiste.txt', ws), '');
});
