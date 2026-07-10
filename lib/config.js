'use strict';
// Configuración persistente en %USERPROFILE%\.dedlit
// Las API keys se guardan cifradas con AES-256-GCM. La clave de cifrado vive
// en un archivo separado (secret.key) en la misma carpeta del usuario: esto
// evita keys en texto plano en disco, aunque quien tenga acceso total a tu
// perfil de usuario podria descifrarlas.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const DIR = path.join(os.homedir(), '.dedlit');
const CONFIG_FILE = path.join(DIR, 'config.json');
const KEY_FILE = path.join(DIR, 'secret.key');

const DEFAULTS = {
  workspace: process.cwd(),
  autoApprove: { read: true, write: false, command: false, network: false },
  mcpServers: {}, // conectores MCP, formato Claude Desktop: {nombre: {command, args, env}}
  lmstudioModelsDir: '', // vacío = ~/.lmstudio/models
  sdWebuiUrl: 'http://127.0.0.1:7860', // Stable Diffusion (Automatic1111/SD.Next/Forge)
  comfyUrl: 'http://127.0.0.1:8188',   // ComfyUI (backend alternativo de imágenes)
  sttUrl: '', // transcripción local OpenAI-compatible (whisper.cpp server, faster-whisper…); vacío = usar proveedor
  ttsUrl: '', // TTS local OpenAI-compatible (kokoro-fastapi, openedai-speech…); vacío = usar proveedor
  customInstructions: '', // instrucciones del usuario añadidas a todos los chats
  promptTemplates: [], // [{name, text}] — plantillas reutilizables del composer
  projects: [], // [{id, name, instructions, ragId}] — agrupan chats con su contexto
  temperature: 0.7,
  maxAgentIterations: 25,
  keys: {},      // providerId -> cifrado {iv, tag, data}
  baseUrls: {},  // providerId -> override de URL base
  lastProvider: '',
  lastModel: ''
};

function ensureDir() {
  if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true });
}

function masterKey() {
  ensureDir();
  if (!fs.existsSync(KEY_FILE)) {
    fs.writeFileSync(KEY_FILE, crypto.randomBytes(32));
  }
  return fs.readFileSync(KEY_FILE);
}

function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', masterKey(), iv);
  const data = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
}

function decrypt(blob) {
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', masterKey(), Buffer.from(blob.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(blob.tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(blob.data, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    return '';
  }
}

function load() {
  ensureDir();
  let cfg = {};
  try {
    cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch { /* primera ejecución */ }
  return { ...DEFAULTS, ...cfg, autoApprove: { ...DEFAULTS.autoApprove, ...(cfg.autoApprove || {}) } };
}

function save(cfg) {
  ensureDir();
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
}

function getKey(cfg, providerId) {
  const blob = cfg.keys[providerId];
  return blob ? decrypt(blob) : '';
}

function setKey(cfg, providerId, value) {
  if (value) cfg.keys[providerId] = encrypt(value);
  else delete cfg.keys[providerId];
}

module.exports = { load, save, getKey, setKey, DIR };
