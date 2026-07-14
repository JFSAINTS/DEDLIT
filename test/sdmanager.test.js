'use strict';
// Tests del gestor de Stable Diffusion: detección de instalación y validación
// de guardas de lanzamiento. NO instala ni ejecuta SD de verdad.
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dedlit-sd-'));
process.env.USERPROFILE = TMP;
process.env.HOME = TMP;

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const sd = require('../lib/sdmanager');

after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} });

test('sdDir usa la ruta por defecto o la configurada', () => {
  assert.match(sd.sdDir({ sdWebuiPath: '' }), /stable-diffusion-webui$/);
  assert.equal(sd.sdDir({ sdWebuiPath: 'C:/mi/sd' }), 'C:/mi/sd');
});

test('installState detecta carpeta ausente, vacía e instalada', () => {
  // ausente
  assert.equal(sd.installState({ sdWebuiPath: path.join(TMP, 'noexiste') }).installed, false);
  // carpeta vacía → no instalado
  const dir = path.join(TMP, 'sd');
  fs.mkdirSync(dir, { recursive: true });
  assert.equal(sd.installState({ sdWebuiPath: dir }).installed, false);
  // con el launcher de la plataforma → instalado
  const launcher = process.platform === 'win32' ? 'webui-user.bat' : 'webui.sh';
  fs.writeFileSync(path.join(dir, launcher), '# launcher');
  assert.equal(sd.installState({ sdWebuiPath: dir }).installed, true);
});

test('launch falla claramente si no está instalado', () => {
  assert.throws(() => sd.launch({ sdWebuiPath: path.join(TMP, 'vacio-total') }), /no está instalado/);
});
