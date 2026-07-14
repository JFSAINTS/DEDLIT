'use strict';
// Instalación y lanzamiento de Stable Diffusion WebUI (AUTOMATIC1111) desde
// DEDLIT. Instalar = git clone del repo; el primer arranque del propio webui
// crea el entorno de Python y descarga torch + un modelo base (varios GB).
// Requisitos del sistema: git y Python 3.10+. Todo local, sin dependencias.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const configLib = require('./config');

const REPO = 'https://github.com/AUTOMATIC1111/stable-diffusion-webui.git';

function sdDir(cfg) {
  return (cfg.sdWebuiPath && cfg.sdWebuiPath.trim()) || path.join(configLib.DIR, 'stable-diffusion-webui');
}

// El launcher según la plataforma
function launcher(dir) {
  return process.platform === 'win32'
    ? { cmd: path.join(dir, 'webui-user.bat'), alt: path.join(dir, 'webui.bat') }
    : { cmd: path.join(dir, 'webui.sh'), alt: path.join(dir, 'webui.sh') };
}

// Estado de instalación: 'none' | 'installed'. (Que esté "corriendo" lo
// decide providers.sdCheck consultando el API.)
function installState(cfg) {
  const dir = sdDir(cfg);
  try {
    if (!fs.existsSync(dir)) return { installed: false, dir };
    const l = launcher(dir);
    const has = fs.existsSync(l.cmd) || fs.existsSync(l.alt) || fs.existsSync(path.join(dir, 'webui.py'));
    return { installed: has, dir };
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
  const dir = sdDir(cfg);
  if (installState(cfg).installed) throw new Error('Stable Diffusion ya está instalado en ' + dir);
  if (!(await hasCommand('git'))) {
    throw new Error('Falta git en el sistema. Instálalo (git-scm.com) y vuelve a intentarlo.');
  }
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  onLine('Clonando ' + REPO + ' …\n(esto descarga el código; el primer arranque instalará Python/torch y un modelo — varios GB)');
  await new Promise((resolve, reject) => {
    const child = spawn('git', ['clone', '--depth', '1', REPO, dir], { windowsHide: true });
    child.stdout.on('data', d => onLine(d.toString()));
    child.stderr.on('data', d => onLine(d.toString())); // git progresa por stderr
    child.on('close', code => code === 0 ? resolve() : reject(new Error('git clone falló (código ' + code + ')')));
    child.on('error', err => reject(new Error('No se pudo ejecutar git: ' + err.message)));
  });
  return { dir };
}

// Lanza el webui con el API activado. En Windows abre una ventana de consola
// para que el usuario vea el progreso (el primer arranque tarda). Devuelve al
// instante; el servidor sondea providers.sdCheck hasta que responda.
function launch(cfg) {
  const st = installState(cfg);
  if (!st.installed) throw new Error('Stable Diffusion no está instalado. Pulsa «Instalar» primero.');
  const dir = st.dir;
  const env = { ...process.env, COMMANDLINE_ARGS: (process.env.COMMANDLINE_ARGS || '') + ' --api' };
  try {
    if (process.platform === 'win32') {
      const bat = fs.existsSync(path.join(dir, 'webui-user.bat')) ? 'webui-user.bat' : 'webui.bat';
      // ventana nueva visible para seguir el arranque
      spawn('cmd.exe', ['/c', 'start', '"Stable Diffusion"', 'cmd', '/k', bat], { cwd: dir, env, windowsHide: false, detached: true }).unref();
    } else {
      const child = spawn('bash', ['webui.sh', '--api'], { cwd: dir, env, detached: true, stdio: 'ignore' });
      child.unref();
    }
    return { dir, launched: true };
  } catch (err) {
    throw new Error('No se pudo lanzar: ' + err.message);
  }
}

module.exports = { sdDir, installState, install, launch, REPO };
