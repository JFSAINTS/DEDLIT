'use strict';
// Test del dialecto Anthropic del gateway: /v1/messages debe aceptar el
// formato de la Messages API (system, content blocks, tool_result, imágenes)
// y responder en formato Anthropic (JSON y SSE con eventos message_*).
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dedlit-anthro-'));
process.env.USERPROFILE = TMP;
process.env.HOME = TMP;
process.env.DEDLIT_SILENT = '1';
process.env.DEDLIT_PORT = '8697';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const configLib = require('../lib/config');

const BASE = 'http://127.0.0.1:8697';
let mock, server, lastReceived;

function startMock() {
  return new Promise(resolve => {
    mock = http.createServer((req, res) => {
      if (req.url === '/v1/models') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end('{"data":[{"id":"m"}]}'); }
      let b = ''; req.on('data', c => b += c); req.on('end', () => {
        lastReceived = JSON.parse(b); // guardar lo que el gateway envió al proveedor
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        // responder con texto + una tool call para ejercitar ambos caminos
        res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'Hola mundo' } }] }) + '\n\n');
        res.write('data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'get_weather', arguments: '{"city":"Madrid"}' } }] } }] }) + '\n\n');
        res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }) + '\n\n');
        res.write('data: [DONE]\n\n'); res.end();
      });
    });
    mock.listen(0, '127.0.0.1', resolve);
  });
}

async function waitReady() {
  for (let i = 0; i < 100; i++) { try { if ((await fetch(BASE + '/api/config')).ok) return; } catch {} await new Promise(r => setTimeout(r, 50)); }
  throw new Error('servidor no arrancó');
}

before(async () => {
  await startMock();
  const cfg = configLib.load();
  cfg.baseUrls.lmstudio = 'http://127.0.0.1:' + mock.address().port + '/v1';
  configLib.save(cfg);
  server = require('../server');
  await waitReady();
});
after(() => {
  try { server.close(); } catch {}
  try { mock.close(); } catch {}
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
});

test('/v1/messages (no streaming) responde en formato Anthropic con tool_use', async () => {
  const r = await (await fetch(BASE + '/v1/messages', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'lmstudio:m',
      system: 'Sé conciso.',
      max_tokens: 100,
      tools: [{ name: 'get_weather', description: 'tiempo', input_schema: { type: 'object', properties: { city: { type: 'string' } } } }],
      messages: [{ role: 'user', content: '¿qué tiempo hace?' }]
    })
  })).json();
  assert.equal(r.type, 'message');
  assert.equal(r.role, 'assistant');
  // bloque de texto + bloque tool_use
  assert.equal(r.content.find(b => b.type === 'text').text, 'Hola mundo');
  const tu = r.content.find(b => b.type === 'tool_use');
  assert.equal(tu.name, 'get_weather');
  assert.deepEqual(tu.input, { city: 'Madrid' });
  assert.equal(r.stop_reason, 'tool_use');
  // el system de Anthropic llegó al proveedor como mensaje system
  assert.ok(lastReceived.messages.some(m => m.role === 'system' && /conciso/.test(m.content)));
  // las tools se tradujeron a function-calling (input_schema → parameters)
  assert.equal(lastReceived.tools[0].function.name, 'get_weather');
});

test('/v1/messages convierte tool_result e imágenes de la entrada', async () => {
  await fetch(BASE + '/v1/messages', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'lmstudio:m', max_tokens: 50,
      messages: [
        { role: 'user', content: [
          { type: 'text', text: 'mira' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QUJD' } }
        ] },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'call_9', name: 'f', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_9', content: 'resultado42' }] }
      ]
    })
  });
  // tool_result → mensaje role tool con el tool_call_id correcto
  const toolMsg = lastReceived.messages.find(m => m.role === 'tool');
  assert.equal(toolMsg.tool_call_id, 'call_9');
  assert.equal(toolMsg.content, 'resultado42');
  // imagen → parte image_url con data-uri
  const userWithImg = lastReceived.messages.find(m => Array.isArray(m.content) && m.content.some(p => p.type === 'image_url'));
  assert.match(userWithImg.content.find(p => p.type === 'image_url').image_url.url, /^data:image\/png;base64,QUJD/);
});

test('/v1/messages (streaming) emite eventos del protocolo Anthropic', async () => {
  const res = await fetch(BASE + '/v1/messages', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'lmstudio:m', max_tokens: 50, stream: true, messages: [{ role: 'user', content: 'hola' }] })
  });
  const text = await res.text();
  assert.match(text, /event: message_start/);
  assert.match(text, /event: content_block_start/);
  assert.match(text, /"type":"text_delta","text":"Hola mundo"/);
  assert.match(text, /"type":"tool_use"/);
  assert.match(text, /"type":"input_json_delta"/);
  assert.match(text, /event: message_delta/);
  assert.match(text, /"stop_reason":"tool_use"/);
  assert.match(text, /event: message_stop/);
});

test('/v1/messages rechaza modelo sin formato proveedor:modelo', async () => {
  const res = await fetch(BASE + '/v1/messages', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'solo-modelo', max_tokens: 10, messages: [{ role: 'user', content: 'x' }] })
  });
  assert.equal(res.status, 400);
  const j = await res.json();
  assert.equal(j.type, 'error');
});
