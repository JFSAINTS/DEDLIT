'use strict';
// Cliente MCP (Model Context Protocol) sobre stdio, sin dependencias.
// Usa el mismo formato de configuración que Claude Desktop:
//   config.mcpServers = { nombre: { command, args, env } }
// Los conectores aportan herramientas al modo agente con el prefijo
// mcp__servidor__herramienta. Si el conector declara readOnlyHint, la
// herramienta se trata como lectura; si no, requiere aprobación como comando.

const { spawn } = require('child_process');
const configLib = require('./config');

const PROTOCOL_VERSION = '2025-06-18';
const servers = new Map(); // nombre -> estado del servidor

function sanitize(s) {
  return String(s).replace(/[^a-zA-Z0-9_-]/g, '_');
}

function send(srv, msg) {
  try { srv.proc.stdin.write(JSON.stringify(msg) + '\n'); } catch { /* proceso muerto */ }
}

function request(srv, method, params, timeoutMs) {
  return new Promise((resolve, reject) => {
    const id = srv.nextId++;
    const timer = setTimeout(() => {
      srv.pending.delete(id);
      reject(new Error('timeout esperando ' + method));
    }, timeoutMs);
    srv.pending.set(id, {
      resolve: v => { clearTimeout(timer); resolve(v); },
      reject: e => { clearTimeout(timer); reject(e); }
    });
    send(srv, { jsonrpc: '2.0', id, method, params });
  });
}

function handleLine(srv, line) {
  line = line.trim();
  if (!line) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; } // tolerar logs en stdout
  if (msg.id !== undefined && srv.pending.has(msg.id)) {
    const p = srv.pending.get(msg.id);
    srv.pending.delete(msg.id);
    if (msg.error) p.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
    else p.resolve(msg.result);
  } else if (msg.id !== undefined && msg.method) {
    // peticiones del servidor al cliente (sampling, roots…): no soportadas
    send(srv, { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'método no soportado por DEDLIT' } });
  }
}

async function startServer(name, def) {
  const srv = {
    name, proc: null, tools: [], status: 'iniciando', error: '',
    pending: new Map(), nextId: 1, buf: '', stderrTail: '', configKey: JSON.stringify(def)
  };
  servers.set(name, srv);
  try {
    srv.proc = spawn(def.command, def.args || [], {
      env: { ...process.env, ...(def.env || {}) },
      shell: process.platform === 'win32', // resuelve npx.cmd, etc.
      windowsHide: true
    });
  } catch (err) {
    srv.status = 'error'; srv.error = err.message;
    return srv;
  }
  srv.proc.stdout.on('data', d => {
    srv.buf += d.toString();
    let i;
    while ((i = srv.buf.indexOf('\n')) >= 0) {
      handleLine(srv, srv.buf.slice(0, i));
      srv.buf = srv.buf.slice(i + 1);
    }
  });
  srv.proc.stderr.on('data', d => { srv.stderrTail = (srv.stderrTail + d.toString()).slice(-2000); });
  srv.proc.on('error', err => { srv.status = 'error'; srv.error = err.message; });
  srv.proc.on('exit', code => {
    if (srv.status !== 'detenido' && srv.status !== 'error') {
      srv.status = 'error';
      srv.error = 'el proceso terminó (código ' + code + '). ' + srv.stderrTail.slice(-300);
    }
  });

  try {
    // timeout generoso: npx descarga el paquete la primera vez
    await request(srv, 'initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'dedlit-studio', version: '0.3.0' }
    }, 120000);
    send(srv, { jsonrpc: '2.0', method: 'notifications/initialized' });
    const res = await request(srv, 'tools/list', {}, 30000);
    srv.tools = (res.tools || []).map(t => ({
      mcpName: t.name,
      name: ('mcp__' + sanitize(name) + '__' + sanitize(t.name)).slice(0, 64),
      description: (t.description || '').slice(0, 1024),
      parameters: t.inputSchema || { type: 'object', properties: {} },
      category: t.annotations && t.annotations.readOnlyHint ? 'read' : 'command'
    }));
    srv.status = 'ok';
  } catch (err) {
    if (srv.status !== 'error') {
      srv.status = 'error';
      srv.error = err.message + (srv.stderrTail ? ' — ' + srv.stderrTail.slice(-300) : '');
    }
    try { srv.proc.kill(); } catch { /* ya muerto */ }
  }
  return srv;
}

function stopServer(name) {
  const srv = servers.get(name);
  if (!srv) return;
  srv.status = 'detenido';
  try { srv.proc?.kill(); } catch { /* ya muerto */ }
  servers.delete(name);
}

// Arranca/detiene conectores para que coincidan con la configuración.
// Idempotente: si nada cambió, no hace nada.
async function sync(cfg) {
  const wanted = cfg.mcpServers || {};
  for (const [name, srv] of [...servers]) {
    const def = wanted[name];
    if (!def || srv.configKey !== JSON.stringify(def)) stopServer(name);
  }
  const starts = [];
  for (const [name, def] of Object.entries(wanted)) {
    if (!def || !def.command || servers.has(name)) continue;
    starts.push(startServer(name, def));
  }
  await Promise.all(starts);
}

function getTools() {
  const out = [];
  for (const srv of servers.values()) {
    if (srv.status === 'ok') out.push(...srv.tools);
  }
  return out;
}

function findTool(name) {
  for (const srv of servers.values()) {
    const t = srv.tools.find(t => t.name === name);
    if (t) return { srv, t };
  }
  return null;
}

function isMcpTool(name) {
  return typeof name === 'string' && name.startsWith('mcp__');
}

function toolCategory(name) {
  const f = findTool(name);
  return f ? f.t.category : 'command';
}

async function execute(name, args) {
  const f = findTool(name);
  if (!f) return 'ERROR: herramienta de conector no encontrada: ' + name;
  try {
    const res = await request(f.srv, 'tools/call', { name: f.t.mcpName, arguments: args || {} }, 120000);
    const parts = (res.content || []).map(c => {
      if (c.type === 'text') return c.text;
      if (c.type === 'image') return '[imagen devuelta por el conector]';
      if (c.type === 'resource') return '[recurso: ' + (c.resource?.uri || '') + ']';
      return '[' + c.type + ']';
    });
    const text = parts.join('\n') || '(sin contenido)';
    return (res.isError ? 'ERROR del conector: ' : '') + text.slice(0, 30000);
  } catch (err) {
    return 'ERROR al llamar al conector: ' + err.message;
  }
}

function status() {
  return [...servers.values()].map(s => ({
    name: s.name, status: s.status, error: s.error, tools: s.tools.length
  }));
}

// ---------- Herramientas de gestión: el agente puede ampliarse a sí mismo ----------

const MANAGEMENT_TOOLS = [
  {
    name: 'add_mcp_connector',
    category: 'command',
    description: 'Añade y arranca un conector MCP (Model Context Protocol) para ampliar tus propias herramientas; tras añadirlo con éxito, sus herramientas mcp__nombre__* quedan disponibles de inmediato en esta misma conversación. Ejemplo para controlar el navegador: name="navegador", command="npx", args=["-y","@playwright/mcp@latest"]. Busca conectores para otras capacidades en registros públicos de MCP.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Nombre corto del conector (letras/números)' },
        command: { type: 'string', description: 'Ejecutable, p. ej. npx, node, uvx' },
        args: { type: 'array', items: { type: 'string' }, description: 'Argumentos del comando' },
        env: { type: 'object', additionalProperties: { type: 'string' }, description: 'Variables de entorno (tokens, etc.)' }
      },
      required: ['name', 'command']
    }
  },
  {
    name: 'list_mcp_connectors',
    category: 'read',
    description: 'Lista los conectores MCP configurados, su estado y las herramientas que aportan.',
    parameters: { type: 'object', properties: {} }
  }
];

function isManagementTool(name) {
  return MANAGEMENT_TOOLS.some(t => t.name === name);
}

async function manage(name, args, cfg) {
  if (name === 'list_mcp_connectors') {
    await sync(cfg);
    const lines = [...servers.values()].map(s =>
      s.name + ': ' + s.status +
      (s.error ? ' — ' + s.error : '') +
      (s.status === 'ok' ? ' — herramientas: ' + s.tools.map(t => t.name).join(', ') : ''));
    return lines.join('\n') || '(sin conectores configurados)';
  }
  if (name === 'add_mcp_connector') {
    const cname = sanitize(String(args.name || '')).slice(0, 20);
    if (!cname || !args.command) return 'ERROR: se requieren name y command';
    const def = {
      command: String(args.command),
      args: Array.isArray(args.args) ? args.args.map(String) : []
    };
    if (args.env && typeof args.env === 'object') def.env = args.env;
    cfg.mcpServers[cname] = def;
    configLib.save(cfg);
    stopServer(cname); // reiniciar si ya existía con otra definición
    await sync(cfg);
    const srv = servers.get(cname);
    if (!srv) return 'ERROR: el conector no llegó a iniciarse';
    if (srv.status !== 'ok') return 'ERROR al iniciar el conector: ' + srv.error;
    return 'Conector "' + cname + '" añadido y funcionando. Nuevas herramientas disponibles a partir de tu próximo turno: ' +
      srv.tools.map(t => t.name).join(', ');
  }
  return 'ERROR: herramienta de gestión desconocida';
}

module.exports = { sync, getTools, isMcpTool, toolCategory, execute, status, MANAGEMENT_TOOLS, isManagementTool, manage };
