'use strict';
// Detección del hardware local (RAM y GPU/VRAM) y semáforo de compatibilidad
// para archivos de modelo GGUF: verde = cabe entero en VRAM, amarillo = carga
// parcial GPU+CPU o solo CPU, rojo = no cabe en la memoria del equipo.

const os = require('os');
const { execFile } = require('child_process');

let cache = null;
let cacheTime = 0;

function run(cmd, args) {
  return new Promise(resolve => {
    execFile(cmd, args, { timeout: 10000, windowsHide: true }, (err, stdout) => resolve(err ? '' : String(stdout)));
  });
}

async function detectGpusNvidia() {
  const out = await run('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits']);
  const gpus = [];
  for (const line of out.split('\n')) {
    const m = line.trim().match(/^(.+),\s*(\d+)$/);
    if (m) gpus.push({ name: m[1].trim(), vramGB: +(m[2] / 1024).toFixed(1) });
  }
  return gpus;
}

async function detectGpusWindowsRegistry() {
  // qwMemorySize es fiable; Win32_VideoController.AdapterRAM desborda con >4 GB
  const script = "Get-ItemProperty 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}\\0*' -ErrorAction SilentlyContinue | Where-Object { $_.'HardwareInformation.qwMemorySize' } | ForEach-Object { $_.DriverDesc + '|' + $_.'HardwareInformation.qwMemorySize' }";
  const out = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
  const gpus = [];
  for (const line of out.split('\n')) {
    const [name, bytes] = line.trim().split('|');
    if (name && bytes && +bytes > 0) gpus.push({ name: name.trim(), vramGB: +(+bytes / 1073741824).toFixed(1) });
  }
  return gpus;
}

async function detect() {
  if (cache && Date.now() - cacheTime < 5 * 60 * 1000) return cache;
  const ramGB = +(os.totalmem() / 1073741824).toFixed(1);
  const freeRamGB = +(os.freemem() / 1073741824).toFixed(1);
  let gpus = [];
  let unified = false;

  if (process.platform === 'darwin' && process.arch === 'arm64') {
    // Apple Silicon: memoria unificada — la GPU usa la RAM del sistema
    unified = true;
    gpus = [{ name: 'Apple Silicon (memoria unificada)', vramGB: +(ramGB * 0.75).toFixed(1) }];
  } else {
    gpus = await detectGpusNvidia();
    if (!gpus.length && process.platform === 'win32') gpus = await detectGpusWindowsRegistry();
  }

  const totalVramGB = +gpus.reduce((a, g) => a + g.vramGB, 0).toFixed(1);
  cache = { platform: process.platform, arch: process.arch, ramGB, freeRamGB, gpus, totalVramGB, unified };
  cacheTime = Date.now();
  return cache;
}

// Semáforo para un archivo de pesos (bytes). Regla aproximada:
// memoria necesaria ≈ tamaño de pesos × 1.15 + ~1.5 GB de contexto/KV-cache.
function verdict(sizeBytes, sys) {
  const needGB = +(sizeBytes / 1073741824 * 1.15 + 1.5).toFixed(1);
  const combinedGB = sys.unified
    ? sys.ramGB * 0.8 // unificada: no sumar VRAM y RAM, es la misma memoria
    : sys.ramGB * 0.85 + sys.totalVramGB;
  if (sys.totalVramGB > 0 && needGB <= sys.totalVramGB) {
    return { level: 'green', label: 'Cabe entero en la GPU', needGB };
  }
  if (needGB <= combinedGB) {
    return {
      level: 'yellow',
      label: sys.totalVramGB > 0 ? 'Carga parcial GPU+CPU (más lento)' : 'Solo CPU (lento)',
      needGB
    };
  }
  return { level: 'red', label: 'No cabe en la memoria de este equipo', needGB };
}

module.exports = { detect, verdict };
