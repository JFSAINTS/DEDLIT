'use strict';
// Instalación y lanzamiento de ComfyUI desde DEDLIT, con el mismo patrón que
// sdmanager (Stable Diffusion WebUI): instalar = git clone; el primer
// lanzamiento crea un venv de Python e instala torch + requirements (varios
// GB). A diferencia de A1111, ComfyUI no trae un launcher que se auto-instale,
// así que DEDLIT genera uno (dedlit-comfy.bat/.sh) al lanzar.
// Requisitos del sistema: git y Python 3.10+. Todo local, sin dependencias.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const configLib = require('./config');

const REPO = 'https://github.com/comfyanonymous/ComfyUI.git';

function comfyDir(cfg) {
  return (cfg.comfyPath && cfg.comfyPath.trim()) || path.join(configLib.DIR, 'ComfyUI');
}

// Estado de instalación: que esté "corriendo" lo decide providers.comfyCheck.
function installState(cfg) {
  const dir = comfyDir(cfg);
  try {
    return { installed: fs.existsSync(path.join(dir, 'main.py')), dir };
  } catch {
    return { installed: false, dir };
  }
}

function hasCommand(cmd) {
  return new Promise(resolve => {
    const probe = process.platform === 'win32' ? spawn('where', [cmd]) : spawn('which', [cmd]);
    probe.on('close', code => resolve(code === 0));
    probe.on('error', () => resolve(false));
  });
}

// Clona el repo. onLine(texto) recibe líneas de salida para el SSE.
async function install(cfg, onLine) {
  const dir = comfyDir(cfg);
  if (installState(cfg).installed) throw new Error('ComfyUI ya está instalado en ' + dir);
  if (!(await hasCommand('git'))) {
    throw new Error('Falta git en el sistema. Instálalo (git-scm.com) y vuelve a intentarlo.');
  }
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  onLine('Clonando ' + REPO + ' …\n(esto descarga el código; el primer lanzamiento creará el entorno de Python e instalará torch — varios GB)');
  await new Promise((resolve, reject) => {
    const child = spawn('git', ['clone', '--depth', '1', REPO, dir], { windowsHide: true });
    child.stdout.on('data', d => onLine(d.toString()));
    child.stderr.on('data', d => onLine(d.toString())); // git progresa por stderr
    child.on('close', code => code === 0 ? resolve() : reject(new Error('git clone falló (código ' + code + ')')));
    child.on('error', err => reject(new Error('No se pudo ejecutar git: ' + err.message)));
  });
  return { dir };
}

// Genera el launcher que crea el venv e instala dependencias la primera vez.
// Con NVIDIA se usa el índice de wheels CUDA de PyTorch (recomendación oficial
// de ComfyUI); sin ella, el torch estándar de PyPI (CPU / macOS).
async function writeLauncher(dir) {
  const cuda = await hasCommand('nvidia-smi');
  const torch = cuda
    ? 'pip install torch torchvision torchaudio --extra-index-url https://download.pytorch.org/whl/cu126'
    : 'pip install torch torchvision torchaudio';
  if (process.platform === 'win32') {
    const bat = path.join(dir, 'dedlit-comfy.bat');
    fs.writeFileSync(bat, [
      '@echo off',
      'cd /d %~dp0',
      'if not exist venv (',
      '  echo Creando entorno de Python e instalando dependencias (primera vez: varios GB)...',
      '  python -m venv venv || (echo Falta Python 3.10+ en el PATH ^(python.org^) & pause & exit /b 1)',
      '  call venv\\Scripts\\activate.bat',
      '  python -m pip install --upgrade pip',
      '  ' + torch,
      '  pip install -r requirements.txt',
      ') else (',
      '  call venv\\Scripts\\activate.bat',
      ')',
      'python main.py --port 8188',
      'pause'
    ].join('\r\n'));
    return bat;
  }
  const sh = path.join(dir, 'dedlit-comfy.sh');
  fs.writeFileSync(sh, [
    '#!/usr/bin/env bash',
    'cd "$(dirname "$0")"',
    'if [ ! -d venv ]; then',
    '  echo "Creando entorno de Python e instalando dependencias (primera vez: varios GB)..."',
    '  python3 -m venv venv || { echo "Falta Python 3.10+"; exit 1; }',
    '  source venv/bin/activate',
    '  python -m pip install --upgrade pip',
    '  ' + torch,
    '  pip install -r requirements.txt',
    'else',
    '  source venv/bin/activate',
    'fi',
    'python main.py --port 8188'
  ].join('\n'), { mode: 0o755 });
  return sh;
}

// Lanza ComfyUI. En Windows abre una ventana de consola para ver el progreso
// (el primer lanzamiento tarda). Devuelve al instante; el servidor sondea
// providers.comfyCheck hasta que responda.
async function launch(cfg) {
  const st = installState(cfg);
  if (!st.installed) throw new Error('ComfyUI no está instalado. Pulsa «Instalar» primero.');
  const dir = st.dir;
  const script = await writeLauncher(dir);
  try {
    if (process.platform === 'win32') {
      spawn('cmd.exe', ['/c', 'start', '"ComfyUI"', 'cmd', '/k', path.basename(script)], { cwd: dir, windowsHide: false, detached: true }).unref();
    } else {
      const child = spawn('bash', [script], { cwd: dir, detached: true, stdio: 'ignore' });
      child.unref();
    }
    return { dir, launched: true };
  } catch (err) {
    throw new Error('No se pudo lanzar: ' + err.message);
  }
}

module.exports = { comfyDir, installState, install, launch, REPO };
