'use strict';
// Herramientas del modo agente: el modelo puede inspeccionar y modificar el
// equipo local (archivos, comandos PowerShell, git/GitHub via CLI).
// Cada herramienta declara su categoría (read/write/command) para que el
// servidor decida si requiere aprobación del usuario según la configuración.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const media = require('./media');

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
    name: 'search_files',
    category: 'read',
    description: 'Busca texto (o una expresión regular) dentro de los archivos del workspace, de forma recursiva. Devuelve archivo:línea: contenido. Ignora node_modules, .git y dist.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Texto o regex a buscar' },
        path: { type: 'string', description: 'Subcarpeta donde buscar (opcional)' },
        glob: { type: 'string', description: 'Filtro de nombre de archivo, p. ej. *.js (opcional)' },
        max_results: { type: 'number', description: 'Máximo de coincidencias (por defecto 50)' }
      },
      required: ['pattern']
    }
  },
  {
    name: 'fetch_url',
    category: 'network',
    description: 'Descarga una página web o API (GET) y devuelve su contenido como texto (el HTML se convierte a texto plano). Útil para leer documentación, noticias o APIs públicas.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL http(s) a descargar' }
      },
      required: ['url']
    }
  },
  {
    name: 'open_in_browser',
    category: 'command',
    description: 'Abre una URL en el navegador por defecto del usuario (Chrome, Safari, Edge…). Úsalo para mostrarle una página al usuario, no para leerla tú (para eso usa fetch_url).',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL http(s) a abrir' }
      },
      required: ['url']
    }
  },
  {
    name: 'show_media',
    category: 'read',
    description: 'Muestra al usuario un archivo local de imagen, audio o vídeo directamente en el chat. Úsalo SIEMPRE que produzcas o encuentres un archivo multimedia que el usuario pidió (imagen generada, vídeo renderizado, captura…).',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Ruta del archivo multimedia' },
        caption: { type: 'string', description: 'Descripción breve (opcional)' }
      },
      required: ['path']
    }
  },
  {
    name: 'generate_image',
    category: 'network',
    description: 'Genera una imagen a partir de un texto usando el proveedor de imágenes que el usuario tenga configurado (OpenAI gpt-image-1/dall-e-3, xAI grok-2-image o Zhipu cogview) y se la muestra en el chat. Si no hay proveedor con key, devuelve un error: en ese caso busca una alternativa (conector MCP o aplicación local como ComfyUI/Stable Diffusion).',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Descripción de la imagen (mejor en inglés para la mayoría de modelos)' },
        provider: { type: 'string', description: 'Proveedor concreto: openai, xai o zhipu (opcional, se autodetecta)' },
        model: { type: 'string', description: 'Modelo concreto (opcional)' }
      },
      required: ['prompt']
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
      case 'search_files':
        return searchFiles(resolvePath(args.path, workspace), args.pattern, args.glob, args.max_results || 50);
      case 'fetch_url':
        return await fetchUrl(args.url);
      case 'open_in_browser':
        return openInBrowser(args.url);
      case 'show_media': {
        const file = resolvePath(args.path, workspace);
        const stat = fs.statSync(file);
        if (stat.size > 100 * 1024 * 1024) return 'ERROR: el archivo supera los 100 MB';
        const ext = path.extname(file).toLowerCase();
        const kind = (media.MIME[ext] || '').split('/')[0];
        if (!['image', 'audio', 'video'].includes(kind)) {
          return 'ERROR: extensión no soportada (' + ext + '). Soportadas: ' + Object.keys(media.MIME).join(' ');
        }
        const saved = media.saveBuffer(fs.readFileSync(file), ext, path.basename(file, ext).slice(0, 30));
        // El servidor detecta este marcador, emite el medio al chat y lo
        // sustituye por un texto neutro antes de reenviárselo al modelo
        return 'SHOWMEDIA::' + JSON.stringify({
          ref: saved.ref, kind,
          caption: args.caption || path.basename(file),
          forModel: '[El archivo ' + path.basename(file) + ' se ha mostrado al usuario en el chat.]'
        });
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

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.dedlit']);

function globToRegex(glob) {
  return new RegExp('^' + glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i');
}

function searchFiles(root, pattern, glob, maxResults) {
  let regex;
  try { regex = new RegExp(pattern, 'i'); }
  catch { regex = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'); }
  const nameFilter = glob ? globToRegex(glob) : null;
  const results = [];
  const walk = (dir, depth) => {
    if (depth > 12 || results.length >= maxResults) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (results.length >= maxResults) return;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(full, depth + 1);
        continue;
      }
      if (nameFilter && !nameFilter.test(e.name)) continue;
      let stat;
      try { stat = fs.statSync(full); } catch { continue; }
      if (stat.size > 1024 * 1024) continue; // saltar archivos > 1 MB
      let text;
      try { text = fs.readFileSync(full, 'utf8'); } catch { continue; }
      if (text.includes('\0')) continue; // binario
      const lines = text.split('\n');
      for (let i = 0; i < lines.length && results.length < maxResults; i++) {
        if (regex.test(lines[i])) {
          results.push(path.relative(root, full) + ':' + (i + 1) + ': ' + lines[i].trim().slice(0, 200));
        }
      }
    }
  };
  walk(root, 0);
  return truncate(results.join('\n') || '(sin coincidencias)');
}

function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<\/(p|div|h\d|li|tr|br)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();
}

async function fetchUrl(url) {
  if (!/^https?:\/\//i.test(url)) return 'ERROR: solo se permiten URLs http(s)';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; DEDLIT-Studio)' }
    });
    const ct = res.headers.get('content-type') || '';
    let text = await res.text();
    if (ct.includes('html')) text = htmlToText(text);
    return truncate('[HTTP ' + res.status + ', ' + ct.split(';')[0] + ']\n' + text);
  } catch (err) {
    return 'ERROR al descargar: ' + err.message;
  } finally {
    clearTimeout(timer);
  }
}

function openInBrowser(url) {
  if (!/^https?:\/\//i.test(url)) return 'ERROR: solo se permiten URLs http(s)';
  const cmd = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : process.platform === 'darwin' ? ['open', [url]]
    : ['xdg-open', [url]];
  try {
    spawn(cmd[0], cmd[1], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    return 'Abierto en el navegador: ' + url;
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
  return `Eres un agente autónomo que trabaja en la máquina local del usuario y completa tareas de principio a fin.
Entorno: ${osName} (${process.platform}), shell ${shellName}, Node.js ${process.version}.
Workspace actual: ${workspace}

Tienes herramientas para listar directorios, leer/buscar/escribir archivos, descargar páginas web (fetch_url), abrir el navegador del usuario (open_in_browser), generar imágenes (generate_image), mostrar archivos multimedia en el chat (show_media) y ejecutar comandos ${shellName} (incluye git, gh, npm, pip, etc.).
Las herramientas con prefijo mcp__ provienen de conectores MCP (control del navegador, GitHub, bases de datos…).

Si te falta una capacidad para completar la tarea, consíguela en vez de rendirte:
- Instala programas o dependencias con run_command (winget/npm/pip/git…).
- Consulta documentación, APIs o enlaces con fetch_url.
- Amplía tus propias herramientas añadiendo conectores MCP con add_mcp_connector; tras añadir uno, sus herramientas mcp__* aparecen de inmediato. Ejemplo: para controlar el navegador, add_mcp_connector con command "npx" y args ["-y","@playwright/mcp@latest"].
- Para generar imágenes usa generate_image; para audio/vídeo u otras capacidades, busca un conector MCP o una aplicación local (ffmpeg, ComfyUI…) e instálala/úsala con run_command.
- Cuando produzcas un archivo de imagen/audio/vídeo, muéstraselo al usuario con show_media: no basta con decir dónde quedó guardado.

Reglas:
- Antes de modificar algo, inspecciona el estado actual (lee archivos, lista directorios).
- Usa rutas relativas al workspace cuando sea posible.
- Para GitHub usa el CLI "gh" o git; verifica con "git status" antes de commits.
- Explica brevemente qué vas a hacer antes de cada acción y resume el resultado al final.
- Si un comando o herramienta falla, lee el error y prueba otra vía; no repitas lo mismo a ciegas.
- Responde siempre en el idioma del usuario.`;
}

module.exports = { TOOLS, toolCategory, execute, systemPrompt };
