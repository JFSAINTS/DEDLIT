'use strict';
/* 🎥 Cámara IA — webcam con efectos WebGL en tiempo real (60 fps, sin IA) y
   restilizado IA en vivo: cada fotograma se envía a /api/cam/restyle (img2img
   sobre Stable Diffusion/ComfyUI local) con un prompt de estilo y, opcional,
   una imagen de referencia que se aplica sobre el usuario (IP-Adapter si la
   extensión ControlNet está instalada; si no, fundido del fotograma).

   Crear un EFECTO nuevo = añadir una entrada a CAM_EFFECTS con su fragment
   shader (recibe `uv` y debe escribir `gl_FragColor`; uniforms: u_tex, u_res,
   u_time). Crear un SKIN = guardar el estilo actual con 💾 (prompt +
   intensidad + efecto; persiste en localStorage). */

// ---------- Efectos WebGL ----------

const CAM_EFFECTS = {
  none:    { name: '✨ Normal',    body: 'gl_FragColor = texture2D(u_tex, uv);' },
  pixel:   { name: '🕹 Pixelado',  body: `
    vec2 cell = vec2(96.0, 96.0 * u_res.y / u_res.x);
    gl_FragColor = texture2D(u_tex, floor(uv * cell) / cell);` },
  comic:   { name: '💥 Cómic',     body: `
    vec2 px = 1.0 / u_res;
    vec3 c = texture2D(u_tex, uv).rgb;
    float gx = length(texture2D(u_tex, uv + vec2(px.x, 0.0)).rgb) - length(texture2D(u_tex, uv - vec2(px.x, 0.0)).rgb);
    float gy = length(texture2D(u_tex, uv + vec2(0.0, px.y)).rgb) - length(texture2D(u_tex, uv - vec2(0.0, px.y)).rgb);
    float edge = smoothstep(0.18, 0.4, length(vec2(gx, gy)));
    vec3 post = floor(c * 5.0) / 5.0;
    gl_FragColor = vec4(mix(post * 1.15, vec3(0.05), edge), 1.0);` },
  vhs:     { name: '📼 VHS',       body: `
    float y = uv.y + sin(u_time * 3.0 + uv.y * 40.0) * 0.0015;
    float shift = 0.004 + 0.002 * sin(u_time * 1.7);
    vec3 c = vec3(
      texture2D(u_tex, vec2(uv.x + shift, y)).r,
      texture2D(u_tex, vec2(uv.x, y)).g,
      texture2D(u_tex, vec2(uv.x - shift, y)).b);
    float scan = 0.9 + 0.1 * sin(uv.y * u_res.y * 3.14159);
    float noise = fract(sin(dot(uv * u_time, vec2(12.9898, 78.233))) * 43758.5453) * 0.08;
    gl_FragColor = vec4(c * scan + noise, 1.0);` },
  termico: { name: '🌡 Térmico',   body: `
    vec3 c = texture2D(u_tex, uv).rgb;
    float l = dot(c, vec3(0.299, 0.587, 0.114));
    vec3 cold = vec3(0.05, 0.0, 0.35), mid = vec3(0.9, 0.25, 0.55), hot = vec3(1.0, 0.95, 0.3);
    gl_FragColor = vec4(l < 0.5 ? mix(cold, mid, l * 2.0) : mix(mid, hot, l * 2.0 - 1.0), 1.0);` },
  glitch:  { name: '👾 Glitch',    body: `
    float band = floor(uv.y * 24.0);
    float r = fract(sin(band * 91.7 + floor(u_time * 8.0) * 7.3) * 43758.5453);
    float off = (r > 0.85) ? (r - 0.85) * 0.8 : 0.0;
    vec2 p = vec2(fract(uv.x + off), uv.y);
    vec3 c = vec3(texture2D(u_tex, p + vec2(off * 0.5, 0.0)).r, texture2D(u_tex, p).g, texture2D(u_tex, p - vec2(off * 0.5, 0.0)).b);
    gl_FragColor = vec4(c, 1.0);` },
  matrix:  { name: '🟩 Matrix',    body: `
    vec3 c = texture2D(u_tex, uv).rgb;
    float l = dot(c, vec3(0.299, 0.587, 0.114));
    float scan = 0.85 + 0.15 * sin(uv.y * u_res.y * 1.57);
    gl_FragColor = vec4(vec3(0.05, 1.0, 0.25) * l * scan, 1.0);` },
  negativo:{ name: '🔄 Negativo',  body: 'gl_FragColor = vec4(1.0 - texture2D(u_tex, uv).rgb, 1.0);' }
};

// Presets de estilo IA (skins de fábrica): prompt + intensidad recomendada
const CAM_PRESETS = [
  { name: '🎌 Anime',     prompt: 'anime style portrait, cel shading, vibrant colors, detailed anime art', denoise: 0.55 },
  { name: '🌆 Cyberpunk', prompt: 'cyberpunk character, neon lights, futuristic city, glowing implants', denoise: 0.55 },
  { name: '🖌 Óleo',      prompt: 'classical oil painting portrait, thick brush strokes, rembrandt lighting', denoise: 0.5 },
  { name: '🧟 Zombi',     prompt: 'zombie, decaying skin, horror movie makeup, dramatic lighting', denoise: 0.5 },
  { name: '🗿 Estatua',   prompt: 'marble statue, white carved stone, classical sculpture, museum lighting', denoise: 0.6 },
  { name: '🎮 Voxel',     prompt: 'voxel art character, blocky 3d render, minecraft style', denoise: 0.65 },
  { name: '🐉 Fantasía',  prompt: 'fantasy character, ornate armor, magical forest, detailed digital art', denoise: 0.55 },
  { name: '✏️ Boceto',    prompt: 'pencil sketch, hand drawn, crosshatching, sketchbook drawing', denoise: 0.55 }
];

const camState = {
  stream: null, gl: null, raf: 0, open: false, effect: 'none',
  programs: {}, texture: null, t0: 0,
  ai: { on: false, lastImg: null, latency: 0, backend: null, ipAdapter: null },
  ref: { dataUrl: null, img: null },
  rec: null, recChunks: []
};

// ---------- Pipeline WebGL ----------

const CAM_VS = `attribute vec2 a_pos; varying vec2 v_uv;
void main() { v_uv = vec2(a_pos.x, -a_pos.y) * 0.5 + 0.5; gl_Position = vec4(a_pos, 0.0, 1.0); }`;

function camFragSrc(body) {
  return `precision mediump float; varying vec2 v_uv;
uniform sampler2D u_tex; uniform vec2 u_res; uniform float u_time; uniform float u_mirror;
void main() {
  vec2 uv = v_uv;
  if (u_mirror > 0.5) uv.x = 1.0 - uv.x;
  ${body}
}`;
}

function camProgram(gl, effect) {
  if (camState.programs[effect]) return camState.programs[effect];
  const compile = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('Shader: ' + gl.getShaderInfoLog(s));
    return s;
  };
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl.VERTEX_SHADER, CAM_VS));
  gl.attachShader(p, compile(gl.FRAGMENT_SHADER, camFragSrc(CAM_EFFECTS[effect].body)));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('Program: ' + gl.getProgramInfoLog(p));
  camState.programs[effect] = p;
  return p;
}

const camGlCanvas = document.createElement('canvas'); // efectos (fuente para la IA)

function camInitGl() {
  const gl = camGlCanvas.getContext('webgl', { preserveDrawingBuffer: true });
  if (!gl) throw new Error('WebGL no disponible en este navegador');
  camState.gl = gl;
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  camState.texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, camState.texture);
  for (const [k, v] of [['TEXTURE_WRAP_S', 'CLAMP_TO_EDGE'], ['TEXTURE_WRAP_T', 'CLAMP_TO_EDGE'], ['TEXTURE_MIN_FILTER', 'LINEAR'], ['TEXTURE_MAG_FILTER', 'LINEAR']]) {
    gl.texParameteri(gl.TEXTURE_2D, gl[k], gl[v]);
  }
}

function camRenderGl(video) {
  const gl = camState.gl;
  const w = video.videoWidth, h = video.videoHeight;
  if (!w) return;
  if (camGlCanvas.width !== w) { camGlCanvas.width = w; camGlCanvas.height = h; }
  gl.viewport(0, 0, w, h);
  const prog = camProgram(gl, camState.effect);
  gl.useProgram(prog);
  const loc = gl.getAttribLocation(prog, 'a_pos');
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  gl.bindTexture(gl.TEXTURE_2D, camState.texture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
  gl.uniform2f(gl.getUniformLocation(prog, 'u_res'), w, h);
  gl.uniform1f(gl.getUniformLocation(prog, 'u_time'), (performance.now() - camState.t0) / 1000);
  gl.uniform1f(gl.getUniformLocation(prog, 'u_mirror'), $('cam-mirror').checked ? 1 : 0);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
}

// ---------- Bucle de dibujo (vista visible: efecto o resultado IA) ----------

function camDrawLoop() {
  if (!camState.open) return;
  const video = $('cam-video');
  const view = $('cam-view');
  const ctx = view.getContext('2d');
  if (video.videoWidth) {
    camRenderGl(video);
    if (view.width !== video.videoWidth) { view.width = video.videoWidth; view.height = video.videoHeight; }
    if (camState.ai.on && camState.ai.lastImg) {
      ctx.drawImage(camState.ai.lastImg, 0, 0, view.width, view.height);
      // vista original en miniatura (esquina inferior derecha)
      const pw = view.width / 4;
      ctx.drawImage(camGlCanvas, view.width - pw - 8, view.height - pw * view.height / view.width - 8, pw, pw * view.height / view.width);
    } else {
      ctx.drawImage(camGlCanvas, 0, 0);
    }
  }
  camState.raf = requestAnimationFrame(camDrawLoop);
}

// ---------- Bucle IA (fotograma → img2img → mostrar) ----------

// Fotograma de trabajo: lado mayor 512 px, múltiplos de 8. Si hay imagen de
// referencia y el backend no tiene IP-Adapter, se funde aquí sobre el
// fotograma (truco barato para que su estilo/color arrastre al img2img).
function camGrabFrame() {
  const w0 = camGlCanvas.width, h0 = camGlCanvas.height;
  if (!w0) return null;
  const scale = 512 / Math.max(w0, h0);
  const w = Math.max(64, Math.round(w0 * scale / 8) * 8);
  const h = Math.max(64, Math.round(h0 * scale / 8) * 8);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  ctx.drawImage(camGlCanvas, 0, 0, w, h);
  if (camState.ref.img && !camState.ai.ipAdapter) {
    ctx.globalAlpha = Number($('cam-ref-weight').value) * 0.5;
    ctx.drawImage(camState.ref.img, 0, 0, w, h);
    ctx.globalAlpha = 1;
  }
  return { dataUrl: c.toDataURL('image/jpeg', 0.85), w, h };
}

async function camAiLoop() {
  while (camState.open && camState.ai.on) {
    const frame = camGrabFrame();
    if (!frame) { await new Promise(r => setTimeout(r, 200)); continue; }
    const body = {
      image: frame.dataUrl,
      prompt: $('cam-prompt').value.trim(),
      denoise: Number($('cam-denoise').value),
      steps: Number($('cam-steps').value),
      width: frame.w, height: frame.h
    };
    if (camState.ref.dataUrl && camState.ai.ipAdapter) {
      body.refImage = camState.ref.dataUrl;
      body.refWeight = Number($('cam-ref-weight').value);
    }
    const t0 = performance.now();
    try {
      const r = await (await fetch('/api/cam/restyle', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
      })).json();
      if (r.error) throw new Error(r.error);
      const img = new Image();
      img.src = r.image;
      await img.decode();
      camState.ai.lastImg = img;
      camState.ai.latency = (performance.now() - t0) / 1000;
      camSetStatus('🤖 IA en vivo · ' + camState.ai.latency.toFixed(1) + ' s/fotograma (' + (1 / camState.ai.latency).toFixed(1) + ' fps)');
    } catch (err) {
      camSetAi(false);
      camSetStatus('⚠ ' + err.message);
      break;
    }
  }
  if (!camState.ai.on) camState.ai.lastImg = null;
}

function camSetAi(on) {
  camState.ai.on = on;
  $('cam-ai').checked = on;
  if (on) { camSetStatus('🤖 generando primer fotograma…'); camAiLoop(); }
  else { camState.ai.lastImg = null; camSetStatus(''); }
}

function camSetStatus(text) {
  const el = $('cam-status');
  el.textContent = text;
  el.classList.toggle('hidden', !text);
}

// ---------- Backend, cámara y arranque ----------

async function camRefreshBackend() {
  try {
    const s = await (await fetch('/api/cam/status')).json();
    camState.ai.backend = s.backend;
    camState.ai.ipAdapter = s.ipAdapter;
    const el = $('cam-backend');
    if (s.backend === 'sd') el.textContent = '🟢 Stable Diffusion' + (s.ipAdapter ? ' · IP-Adapter ✓' : '');
    else if (s.backend === 'comfy') el.textContent = '🟢 ComfyUI';
    else el.textContent = '🔴 sin backend IA (solo efectos)';
    $('cam-ref-hint').textContent = camState.ref.dataUrl && !s.ipAdapter
      ? 'Sin IP-Adapter (extensión ControlNet): la referencia se funde sobre el fotograma — efecto más suave. Instala ControlNet + un modelo ip-adapter en SD WebUI para aplicarla de verdad.'
      : '';
  } catch { $('cam-backend').textContent = ''; }
}

async function camListDevices() {
  const devices = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'videoinput');
  const sel = $('cam-device');
  const current = sel.value;
  sel.innerHTML = '';
  devices.forEach((d, i) => {
    const o = document.createElement('option');
    o.value = d.deviceId;
    o.textContent = d.label || 'Cámara ' + (i + 1);
    sel.appendChild(o);
  });
  if (current) sel.value = current;
}

async function camStart(deviceId) {
  camStopStream();
  camState.stream = await navigator.mediaDevices.getUserMedia({
    video: { deviceId: deviceId ? { exact: deviceId } : undefined, width: { ideal: 1280 }, height: { ideal: 720 } },
    audio: false
  });
  $('cam-video').srcObject = camState.stream;
  await camListDevices(); // con permiso concedido ya hay etiquetas
}

function camStopStream() {
  if (camState.stream) {
    for (const t of camState.stream.getTracks()) t.stop();
    camState.stream = null;
  }
}

async function openCam() {
  $('cam-overlay').classList.remove('hidden');
  camState.open = true;
  camState.t0 = performance.now();
  try {
    if (!camState.gl) camInitGl();
    await camStart($('cam-device').value || undefined);
    camDrawLoop();
  } catch (err) {
    camSetStatus('⚠ No se pudo abrir la cámara: ' + err.message);
  }
  camRefreshBackend();
  camRenderPresets();
  camRenderSkins();
}

function closeCam() {
  camState.open = false;
  camSetAi(false);
  camRecStop(true);
  cancelAnimationFrame(camState.raf);
  camStopStream();
  $('cam-overlay').classList.add('hidden');
}

// ---------- Presets y skins ----------

function camApplyStyle(p) {
  $('cam-prompt').value = p.prompt;
  if (p.denoise) { $('cam-denoise').value = p.denoise; $('cam-denoise-val').textContent = p.denoise; }
  if (p.steps) { $('cam-steps').value = p.steps; $('cam-steps-val').textContent = p.steps; }
  if (p.effect && CAM_EFFECTS[p.effect]) { camState.effect = p.effect; $('cam-effect').value = p.effect; }
  if (!camState.ai.on && camState.ai.backend) camSetAi(true);
}

function camRenderPresets() {
  const cont = $('cam-presets');
  cont.innerHTML = '';
  for (const p of CAM_PRESETS) {
    const chip = document.createElement('button');
    chip.className = 'cam-chip';
    chip.textContent = p.name;
    chip.onclick = () => camApplyStyle(p);
    cont.appendChild(chip);
  }
}

function camSkins() {
  try { return JSON.parse(localStorage.getItem('dedlit.cam.skins') || '[]'); } catch { return []; }
}

function camRenderSkins() {
  const cont = $('cam-skins');
  cont.innerHTML = '';
  const skins = camSkins();
  if (!skins.length) {
    cont.innerHTML = '<span class="hint">Ajusta el estilo y guárdalo con 💾 para reutilizarlo.</span>';
    return;
  }
  skins.forEach((s, i) => {
    const chip = document.createElement('button');
    chip.className = 'cam-chip skin';
    chip.innerHTML = escapeHtml(s.name) + ' <span class="del" title="Eliminar skin">✕</span>';
    chip.onclick = e => {
      if (e.target.classList.contains('del')) {
        skins.splice(i, 1);
        localStorage.setItem('dedlit.cam.skins', JSON.stringify(skins));
        camRenderSkins();
      } else camApplyStyle(s);
    };
    cont.appendChild(chip);
  });
}

function camSaveSkin() {
  const name = prompt('Nombre del skin:', '');
  if (!name || !name.trim()) return;
  const skins = camSkins();
  skins.push({
    name: name.trim().slice(0, 30),
    prompt: $('cam-prompt').value.trim(),
    denoise: Number($('cam-denoise').value),
    steps: Number($('cam-steps').value),
    effect: camState.effect
  });
  localStorage.setItem('dedlit.cam.skins', JSON.stringify(skins.slice(0, 50)));
  camRenderSkins();
}

// ---------- Captura y grabación ----------

async function camSnapshot() {
  const dataUrl = $('cam-view').toDataURL('image/png');
  const name = 'camara-' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + '.png';
  try {
    const saved = await (await fetch('/api/upload', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, dataUrl })
    })).json();
    if (saved.error) throw new Error(saved.error);
    state.attachments.push({ ref: saved.ref, url: saved.url, kind: 'image', name, format: 'png' });
    renderAttachments();
    camSetStatus('📎 Captura adjuntada al chat');
    setTimeout(() => { if (!camState.ai.on) camSetStatus(''); }, 2500);
  } catch (err) {
    camSetStatus('⚠ ' + err.message);
  }
}

function camRecStop(silent) {
  if (camState.rec && camState.rec.state !== 'inactive') camState.rec.stop();
  else if (!silent) camRecStart();
}

function camRecStart() {
  if (!('MediaRecorder' in window)) { camSetStatus('⚠ Este navegador no soporta grabación'); return; }
  camState.recChunks = [];
  const rec = new MediaRecorder($('cam-view').captureStream(30), { mimeType: 'video/webm' });
  rec.ondataavailable = e => { if (e.data.size) camState.recChunks.push(e.data); };
  rec.onstop = () => {
    $('btn-cam-rec').textContent = '⏺ Grabar';
    $('btn-cam-rec').classList.remove('recording');
    if (!camState.recChunks.length) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(camState.recChunks, { type: 'video/webm' }));
    a.download = 'camara-' + Date.now() + '.webm';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  };
  rec.start();
  camState.rec = rec;
  $('btn-cam-rec').textContent = '⏹ Parar';
  $('btn-cam-rec').classList.add('recording');
}

// ---------- Eventos ----------

{
  const sel = $('cam-effect');
  for (const [id, e] of Object.entries(CAM_EFFECTS)) {
    const o = document.createElement('option');
    o.value = id;
    o.textContent = e.name;
    sel.appendChild(o);
  }
  sel.onchange = () => { camState.effect = sel.value; };
}

$('btn-cam').onclick = openCam;
$('btn-close-cam').onclick = closeCam;
$('cam-overlay').addEventListener('click', e => { if (e.target.id === 'cam-overlay') closeCam(); });
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && camState.open) closeCam();
});
$('cam-device').onchange = () => camStart($('cam-device').value).catch(err => camSetStatus('⚠ ' + err.message));
$('cam-ai').onchange = () => {
  if ($('cam-ai').checked && !camState.ai.backend) {
    $('cam-ai').checked = false;
    camSetStatus('⚠ Arranca Stable Diffusion (con --api) o ComfyUI para el restilizado IA');
    return;
  }
  camSetAi($('cam-ai').checked);
};
$('cam-denoise').oninput = () => { $('cam-denoise-val').textContent = $('cam-denoise').value; };
$('cam-steps').oninput = () => { $('cam-steps-val').textContent = $('cam-steps').value; };
$('cam-ref-weight').oninput = () => { $('cam-ref-weight-val').textContent = $('cam-ref-weight').value; };
$('btn-cam-ref').onclick = () => $('cam-ref-file').click();
$('cam-ref-file').onchange = async e => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  const dataUrl = await new Promise((ok, ko) => {
    const r = new FileReader();
    r.onload = () => ok(r.result);
    r.onerror = ko;
    r.readAsDataURL(file);
  });
  const img = new Image();
  img.src = dataUrl;
  await img.decode();
  camState.ref = { dataUrl, img };
  $('cam-ref-preview').src = dataUrl;
  $('cam-ref-preview').classList.remove('hidden');
  $('btn-cam-ref-clear').classList.remove('hidden');
  camRefreshBackend(); // actualiza la pista sobre IP-Adapter
};
$('btn-cam-ref-clear').onclick = () => {
  camState.ref = { dataUrl: null, img: null };
  $('cam-ref-preview').classList.add('hidden');
  $('btn-cam-ref-clear').classList.add('hidden');
  $('cam-ref-hint').textContent = '';
};
$('btn-cam-skin-save').onclick = camSaveSkin;
$('btn-cam-shot').onclick = camSnapshot;
$('btn-cam-rec').onclick = () => camRecStop(false);
