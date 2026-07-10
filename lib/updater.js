'use strict';
// Auto-actualización desde GitHub Releases. Al abrir, el cliente consulta
// /api/update/check (desactivable en Ajustes); si hay versión nueva se avisa
// con un banner y, previa confirmación, /api/update/install descarga el
// binario de la plataforma, lanza un script auxiliar que reemplaza el
// ejecutable cuando el proceso termina, y relanza la aplicación.
// Repo privado: token opcional de GitHub cifrado en config (keys.ghupdate).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const configLib = require('./config');

const REPO = 'JFSAINTS/DEDLIT';
const PKG_VERSION = require('../package.json').version;

function currentVersion() {
  return process.env.DEDLIT_VERSION_OVERRIDE || PKG_VERSION; // override solo para pruebas
}

function assetName() {
  if (process.platform === 'win32') return 'dedlit-studio-win-x64.exe';
  if (process.platform === 'darwin') return process.arch === 'arm64' ? 'dedlit-studio-macos-arm64' : 'dedlit-studio-macos-x64';
  return 'dedlit-studio-linux-x64';
}

// compara versiones x.y.z → 1 si a>b, -1 si a<b, 0 si iguales
function cmpVer(a, b) {
  const pa = String(a).replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b).replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0) ? 1 : -1;
  }
  return 0;
}

function ghHeaders(cfg, accept) {
  const headers = { 'User-Agent': 'dedlit-studio', 'Accept': accept, 'X-GitHub-Api-Version': '2022-11-28' };
  const token = configLib.getKey(cfg, 'ghupdate');
  if (token) headers.Authorization = 'Bearer ' + token;
  return headers;
}

async function check(cfg) {
  const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
    headers: ghHeaders(cfg, 'application/vnd.github+json')
  });
  if (res.status === 404 || res.status === 401 || res.status === 403) {
    throw new Error('No se pudo consultar la última versión (HTTP ' + res.status + '). Si el repositorio es privado, añade un token de GitHub en Ajustes → Actualizaciones.');
  }
  if (!res.ok) throw new Error('GitHub HTTP ' + res.status);
  const rel = await res.json();
  const latest = String(rel.tag_name || '').replace(/^v/, '');
  const asset = (rel.assets || []).find(a => a.name === assetName());
  const packaged = !!process.pkg;
  const inMacApp = process.execPath.includes('.app' + path.sep + 'Contents') || process.execPath.includes('.app/Contents');
  return {
    current: currentVersion(),
    latest,
    hasUpdate: !!latest && cmpVer(latest, currentVersion()) > 0,
    notes: String(rel.body || '').slice(0, 1500),
    url: rel.html_url || ('https://github.com/' + REPO + '/releases'),
    assetId: asset ? asset.id : null,
    assetSize: asset ? asset.size : 0,
    // desde código fuente o dentro de un .app firmado no se auto-reemplaza
    canAutoInstall: packaged && !inMacApp && !!asset
  };
}

async function install(cfg, onProgress) {
  const info = await check(cfg);
  if (!info.hasUpdate) throw new Error('Ya estás en la última versión (' + info.current + ')');
  if (!info.canAutoInstall) {
    throw new Error('La instalación automática no está disponible en este modo de ejecución. Descarga la nueva versión de ' + info.url);
  }

  const res = await fetch(`https://api.github.com/repos/${REPO}/releases/assets/${info.assetId}`, {
    headers: ghHeaders(cfg, 'application/octet-stream'),
    redirect: 'follow'
  });
  if (!res.ok) throw new Error('Descarga fallida: HTTP ' + res.status);

  const target = process.execPath;
  const tmp = target + '.update';
  const out = fs.createWriteStream(tmp);
  let received = 0;
  let lastPct = -1;
  for await (const chunk of res.body) {
    out.write(chunk);
    received += chunk.length;
    const pct = info.assetSize ? Math.floor(received / info.assetSize * 100) : 0;
    if (pct !== lastPct && onProgress) {
      lastPct = pct;
      onProgress(pct, received);
    }
  }
  await new Promise(r => out.end(r));
  if (info.assetSize && received < info.assetSize * 0.98) {
    fs.unlinkSync(tmp);
    throw new Error('Descarga incompleta (' + received + ' de ' + info.assetSize + ' bytes)');
  }

  // Script auxiliar: espera a que este proceso termine, reemplaza y relanza.
  // En Windows se usa PowerShell: cmd/timeout fallan sin consola (stdin).
  if (process.platform === 'win32') {
    const ps1 = path.join(os.tmpdir(), 'dedlit-update-' + process.pid + '.ps1');
    fs.writeFileSync(ps1, [
      `while (Get-Process -Id ${process.pid} -ErrorAction SilentlyContinue) { Start-Sleep -Milliseconds 500 }`,
      `Start-Sleep -Milliseconds 500`,
      `Move-Item -Force -LiteralPath '${tmp.replace(/'/g, "''")}' -Destination '${target.replace(/'/g, "''")}'`,
      // el proceso WMI no hereda el entorno: conservar el puerto configurado
      `$env:DEDLIT_PORT = '${String(process.env.DEDLIT_PORT || 8642).replace(/'/g, '')}'`,
      `Start-Process -FilePath '${target.replace(/'/g, "''")}'`,
      `Remove-Item -Force -LiteralPath $MyInvocation.MyCommand.Path`
    ].join('\r\n'));
    // Crear el proceso vía WMI: queda fuera del árbol (y de cualquier Job
    // Object) del proceso actual, así sobrevive con seguridad a nuestra salida
    const cmdLine = `powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${ps1}"`;
    const wmi = `Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = '${cmdLine.replace(/'/g, "''")}' } | Out-Null`;
    const r = require('child_process').spawnSync('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', wmi],
      { timeout: 20000, windowsHide: true });
    if (r.status !== 0) {
      // último recurso: spawn desacoplado clásico
      spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', ps1], {
        detached: true, stdio: 'ignore', windowsHide: true
      }).unref();
    }
  } else {
    const sh = path.join(os.tmpdir(), 'dedlit-update-' + process.pid + '.sh');
    fs.writeFileSync(sh, [
      '#!/bin/sh',
      `while kill -0 ${process.pid} 2>/dev/null; do sleep 1; done`,
      `mv -f "${tmp}" "${target}"`,
      `chmod +x "${target}"`,
      `export DEDLIT_PORT='${String(process.env.DEDLIT_PORT || 8642).replace(/'/g, '')}'`,
      `nohup "${target}" >/dev/null 2>&1 &`,
      `rm -f "$0"`
    ].join('\n'), { mode: 0o755 });
    spawn('/bin/sh', [sh], { detached: true, stdio: 'ignore' }).unref();
  }

  // dar tiempo a que el evento SSE de éxito llegue al cliente y salir
  setTimeout(() => process.exit(0), 1500);
  return info;
}

module.exports = { check, install, currentVersion, cmpVer, REPO };
