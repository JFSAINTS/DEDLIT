'use strict';
// Herramientas del modo agente: el modelo puede inspeccionar y modificar el
// equipo local (archivos, comandos PowerShell, git/GitHub via CLI).
// Cada herramienta declara su categoría (read/write/command) para que el
// servidor decida si requiere aprobación del usuario según la configuración.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const MAX_OUTPUT = 30000;

const TOOLS = [
  {
    name: 'list_directory',
    category: 'read',
    description: 'Lista archivos y subcarpetas de un directorio. Ruta relativa al workspace o absoluta.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Ruta del directorio (por defecto, la raíz del workspace)' } },
      required: []
    }
  },
  {
    name: 'read_file',
    category: 'read',
    description: 'Lee el contenido de un archivo de texto. Devuelve hasta 30000 caracteres.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Ruta del archivo' },
        offset: { type: 'number', description: 'Línea inicial (opcional, 1-indexado)' },
        limit: { type: 'number', description: 'Número máximo de líneas (opcional)' }
      },
      required: ['path']
    }
  },
  {
    name: 'write_file',
    category: 'write',
    description: 'Crea o sobrescribe un archivo con el contenido dado. Crea las carpetas intermedias si no existen.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Ruta del archivo' },
        content: { type: 'string', description: 'Contenido completo del archivo' }
      },
      required: ['path', 'content']
    }
  },
  {
    name: 'run_command',
    category: 'command',
    description: `Ejecuta un comando en el shell del sistema (${process.platform === 'win32' ? 'PowerShell' : 'bash'}) dentro del workspace. Úsalo para instalar paquetes, ejecutar tests, git, gh (GitHub CLI), verificar versiones, etc. Timeout de 120 segundos.`,
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Comando a ejecutar' },
        cwd: { type: 'string', description: 'Directorio de trabajo (opcional, por defecto el workspace)' }
      },
      required: ['command']
    }
  }
];

function toolCategory(name) {
  const t = TOOLS.find(t => t.name === name);
  return t ? t.category : 'command';
}

function resolvePath(p, workspace) {
  if (!p) return workspace;
  return path.isAbsolute(p) ? p : path.join(workspace, p);
}

function truncate(s) {
  s = String(s ?? '');
  return s.length > MAX_OUTPUT ? s.slice(0, MAX_OUTPUT) + `\n... [truncado, ${s.length} caracteres en total]` : s;
}

async function execute(name, args, workspace) {
  try {
    switch (name) {
      case 'list_directory': {
        const dir = resolvePath(args.path, workspace);
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        return truncate(entries.map(e => (e.isDirectory() ? '[DIR]  ' : '[FILE] ') + e.name).join('\n') || '(directorio vacío)');
      }
      case 'read_file': {
        const file = resolvePath(args.path, workspace);
        let text = fs.readFileSync(file, 'utf8');
        if (args.offset || args.limit) {
          const lines = text.split('\n');
          const start = Math.max(0, (args.offset || 1) - 1);
          text = lines.slice(start, args.limit ? start + args.limit : undefined).join('\n');
        }
        return truncate(text);
      }
      case 'write_file': {
        const file = resolvePath(args.path, workspace);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, String(args.content ?? ''), 'utf8');
        return 'Archivo escrito: ' + file + ' (' + String(args.content ?? '').length + ' caracteres)';
      }
      case 'run_command':
        return await runShell(args.command, resolvePath(args.cwd, workspace));
      default:
        return 'Herramienta desconocida: ' + name;
    }
  } catch (err) {
    return 'ERROR: ' + err.message;
  }
}

function runShell(command, cwd) {
  return new Promise((resolve) => {
    const child = process.platform === 'win32'
      ? spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { cwd, windowsHide: true })
      : spawn('/bin/bash', ['-lc', command], { cwd });
    let out = '';
    const append = d => { if (out.length < MAX_OUTPUT * 2) out += d.toString(); };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    const timer = setTimeout(() => {
      child.kill();
      out += '\n[Proceso terminado por timeout de 120s]';
    }, 120000);
    child.on('close', code => {
      clearTimeout(timer);
      resolve(truncate((out || '(sin salida)') + '\n[exit code: ' + code + ']'));
    });
    child.on('error', err => {
      clearTimeout(timer);
      resolve('ERROR al ejecutar: ' + err.message);
    });
  });
}

function systemPrompt(workspace) {
  const isWin = process.platform === 'win32';
  const osName = isWin ? 'Windows' : (process.platform === 'darwin' ? 'macOS' : 'Linux');
  const shellName = isWin ? 'PowerShell' : 'bash';
  return `Eres un agente de desarrollo que trabaja en la máquina local del usuario.
Entorno: ${osName} (${process.platform}), shell ${shellName}, Node.js ${process.version}.
Workspace actual: ${workspace}

Tienes herramientas para listar directorios, leer y escribir archivos, y ejecutar comandos ${shellName} (incluye git, gh, npm, pip, etc.).
Reglas:
- Antes de modificar algo, inspecciona el estado actual (lee archivos, lista directorios).
- Usa rutas relativas al workspace cuando sea posible.
- Para GitHub usa el CLI "gh" o git; verifica con "git status" antes de commits.
- Explica brevemente qué vas a hacer antes de cada acción y resume el resultado al final.
- Si un comando falla, lee el error y corrige; no repitas el mismo comando a ciegas.
- Responde siempre en el idioma del usuario.`;
}

module.exports = { TOOLS, toolCategory, execute, systemPrompt };
