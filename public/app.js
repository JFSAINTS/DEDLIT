'use strict';
/* DEDLIT Studio — cliente. Sin frameworks ni CDNs: todo local. */

const $ = id => document.getElementById(id);

const state = {
  config: null,
  chatIndex: [],     // metadatos [{id, title, updatedAt, count}] — el contenido vive en disco
  currentChat: null, // chat completo abierto
  streaming: false,
  abortController: null,
  attachments: [] // {ref, url, kind: 'image'|'audio'|'video', name, format}
};

// ---------- Mini-renderizador de Markdown ----------

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ---------- Tema claro/oscuro ----------

function applyTheme(theme) {
  document.documentElement.classList.toggle('light', theme === 'light');
  localStorage.setItem('dedlit.theme', theme);
}

function toggleTheme() {
  applyTheme(document.documentElement.classList.contains('light') ? 'dark' : 'light');
}

applyTheme(localStorage.getItem('dedlit.theme') || 'dark');

function renderMarkdown(src) {
  const blocks = [];
  // Extraer bloques de código primero para no procesarlos
  let text = src.replace(/```(\w*)\n?([\s\S]*?)(```|$)/g, (_, lang, code) => {
    blocks.push(`<pre><code>${escapeHtml(code.replace(/\n$/, ''))}</code></pre>`);
    return `\uE000${blocks.length - 1}\uE001`;
  });
  text = escapeHtml(text)
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/^###### (.+)$/gm, '<h6>$1</h6>')
    .replace(/^##### (.+)$/gm, '<h5>$1</h5>')
    .replace(/^#### (.+)$/gm, '<h4>$1</h4>')
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^# (.+)$/gm, '<h1>$1</h1>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/(^|\s)\*([^*\n]+)\*/g, '$1<i>$2</i>')
    .replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>')
    .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');

  // Listas
  text = text.replace(/((?:^[-*] .+\n?)+)/gm, m =>
    '<ul>' + m.trim().split('\n').map(l => '<li>' + l.replace(/^[-*] /, '') + '</li>').join('') + '</ul>');
  text = text.replace(/((?:^\d+\. .+\n?)+)/gm, m =>
    '<ol>' + m.trim().split('\n').map(l => '<li>' + l.replace(/^\d+\. /, '') + '</li>').join('') + '</ol>');

  // Párrafos
  text = text.split(/\n{2,}/).map(p => {
    if (/^<(h\d|ul|ol|blockquote|pre)/.test(p.trim())) return p;
    return '<p>' + p.replace(/\n/g, '<br>') + '</p>';
  }).join('\n');

  return text.replace(/\uE000(\d+)\uE001/g, (_, i) => blocks[+i]);
}

// ---------- Medios ----------

function refUrl(ref) {
  return ref.startsWith('media:') ? '/media/' + encodeURIComponent(ref.slice(6)) : ref;
}

function mediaKind(mime) {
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('video/')) return 'video';
  return null;
}

// Convierte las partes de un mensaje (formato interno OpenAI) a HTML
function renderParts(content) {
  if (!Array.isArray(content)) return renderMarkdown(String(content ?? ''));
  let html = '';
  for (const p of content) {
    if (p.type === 'text') html += renderMarkdown(p.text || '');
    else if (p.type === 'image_url') {
      const u = refUrl(p.image_url?.url || '');
      html += `<a href="${u}" target="_blank"><img class="media" src="${u}" alt="imagen"></a>`;
    } else if (p.type === 'input_audio') {
      html += `<audio controls src="${refUrl(p.input_audio?.data || '')}"></audio>`;
    } else if (p.type === 'video_url') {
      html += `<video controls src="${refUrl(p.video_url?.url || '')}"></video>`;
    }
  }
  return html;
}

// ---------- Capacidades estimadas por nombre de modelo ----------

const CAP_RULES = [
  { re: /gpt-4o|gpt-4\.1|gpt-4-turbo|gpt-5|^o[134]|vision|llava|moondream|minicpm|qwen[\w.-]*vl|pixtral|gemma-?3|gemini|claude|grok-[234]|glm-4v|internvl|llama-?3\.2|llama-?4|omni/i, cap: '👁️ visión', gen: false },
  { re: /gpt-4o-audio|omni|gemini|voxtral|audio/i, cap: '🎧 entrada audio', gen: false },
  { re: /gemini|omni|qwen[\w.-]*vl-max|video/i, cap: '🎬 entrada vídeo', gen: false },
  { re: /dall-e|gpt-image|imagen-|grok-2-image|cogview|wanx|flux|stable-diffusion|sdxl/i, cap: '🖼️ genera imágenes', gen: true },
  { re: /tts|speech/i, cap: '🔊 texto a voz', gen: true },
  { re: /whisper|transcribe/i, cap: '📝 transcripción', gen: true }
];

function updateCaps() {
  const model = currentModel();
  const cont = $('model-caps');
  cont.innerHTML = '';
  if (!model) return;
  for (const rule of CAP_RULES) {
    if (rule.re.test(model)) {
      const chip = document.createElement('span');
      chip.className = 'cap-chip' + (rule.gen ? ' gen' : '');
      chip.textContent = rule.cap;
      cont.appendChild(chip);
    }
  }
}

// ---------- Adjuntos ----------

async function addFiles(files) {
  for (const file of files) {
    const kind = mediaKind(file.type || '');
    if (!kind) { alert('Tipo no soportado: ' + (file.type || file.name)); continue; }
    if (file.size > 60 * 1024 * 1024) { alert(file.name + ' supera los 60 MB'); continue; }
    const dataUrl = await new Promise((ok, ko) => {
      const r = new FileReader();
      r.onload = () => ok(r.result);
      r.onerror = ko;
      r.readAsDataURL(file);
    });
    const res = await fetch('/api/upload', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: file.name, dataUrl })
    });
    const saved = await res.json();
    if (saved.error) { alert('Error al subir ' + file.name + ': ' + saved.error); continue; }
    state.attachments.push({
      ref: saved.ref, url: saved.url, kind, name: file.name,
      format: (file.name.split('.').pop() || 'mp3').toLowerCase()
    });
  }
  renderAttachments();
}

function renderAttachments() {
  const cont = $('attachments');
  cont.innerHTML = '';
  cont.classList.toggle('hidden', !state.attachments.length);
  state.attachments.forEach((a, i) => {
    const chip = document.createElement('div');
    chip.className = 'attach-chip';
    const icon = a.kind === 'image' ? `<img src="${a.url}" alt="">` :
      `<span class="kind-icon">${a.kind === 'audio' ? '🎧' : '🎬'}</span>`;
    chip.innerHTML = `${icon}<span class="aname">${escapeHtml(a.name)}</span><span class="aremove" title="Quitar">✕</span>`;
    chip.querySelector('.aremove').onclick = () => {
      state.attachments.splice(i, 1);
      renderAttachments();
    };
    cont.appendChild(chip);
  });
}

function buildUserContent(text) {
  if (!state.attachments.length) return text;
  const parts = [];
  if (text) parts.push({ type: 'text', text });
  for (const a of state.attachments) {
    if (a.kind === 'image') parts.push({ type: 'image_url', image_url: { url: a.ref } });
    else if (a.kind === 'audio') parts.push({ type: 'input_audio', input_audio: { data: a.ref, format: a.format } });
    else if (a.kind === 'video') parts.push({ type: 'video_url', video_url: { url: a.ref } });
  }
  return parts;
}

// ---------- Persistencia de chats (en disco, vía servidor) ----------

async function loadChatIndex() {
  try {
    state.chatIndex = (await (await fetch('/api/chats')).json()).chats || [];
  } catch {
    state.chatIndex = [];
  }
}

// Migración única desde localStorage (versiones anteriores)
async function migrateLocalChats() {
  let old = [];
  try { old = JSON.parse(localStorage.getItem('dedlit.chats') || '[]'); } catch { return; }
  if (!old.length) return;
  for (const chat of old) {
    if (chat.messages && chat.messages.length) {
      await fetch('/api/chats', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat })
      }).catch(() => {});
    }
  }
  localStorage.removeItem('dedlit.chats');
}

// Guarda el chat actual en disco y actualiza el índice local
function saveChats() {
  const chat = state.currentChat;
  if (!chat || !chat.messages.length) return;
  chat.updatedAt = Date.now();
  fetch('/api/chats', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat })
  }).catch(() => {});
  const meta = { id: chat.id, title: chat.title, updatedAt: chat.updatedAt, count: chat.messages.length, projectId: chat.projectId || '' };
  const i = state.chatIndex.findIndex(c => c.id === chat.id);
  if (i >= 0) state.chatIndex[i] = meta;
  else state.chatIndex.unshift(meta);
}

function newChat() {
  state.currentChat = {
    id: Date.now().toString(36), title: 'Nueva conversación', messages: [],
    createdAt: Date.now(), projectId: projectFilter() || ''
  };
  renderChatList();
  renderMessages();
}

async function openChat(id) {
  try {
    const chat = await (await fetch('/api/chats/' + encodeURIComponent(id))).json();
    if (chat.error) throw new Error(chat.error);
    state.currentChat = chat;
    await applyChatSettings(chat.settings);
  } catch (err) {
    errorCard('No se pudo abrir la conversación: ' + err.message);
  }
  renderChatList();
  renderMessages();
}

// Cada chat recuerda su proveedor/modelo/agente/colección RAG
async function applyChatSettings(s) {
  if (!s) return;
  if (s.provider && state.config?.providers?.[s.provider]) {
    $('sel-provider').value = s.provider;
    await loadModels(s.model);
    if (s.model && $('sel-model').value !== s.model) $('inp-model-manual').value = s.model;
    else $('inp-model-manual').value = '';
    updateCaps();
  }
  $('chk-agent').checked = !!s.agentMode;
  const ragSel = $('sel-rag');
  const ragId = s.ragId || '';
  if ([...ragSel.options].some(o => o.value === ragId)) ragSel.value = ragId;
}

async function deleteChat(id) {
  await fetch('/api/chats/' + encodeURIComponent(id), { method: 'DELETE' }).catch(() => {});
  state.chatIndex = state.chatIndex.filter(c => c.id !== id);
  if (state.currentChat?.id === id) state.currentChat = null;
  renderChatList();
  renderMessages();
}

// items: opcional, resultados de búsqueda [{id,title,snippet}]
function renderChatList(items) {
  const list = $('chat-list');
  list.innerHTML = '';
  let metas = items || [...state.chatIndex].sort((a, b) => b.updatedAt - a.updatedAt);
  // filtrar por proyecto activo (solo en la vista normal, no en búsquedas)
  const proj = projectFilter();
  if (!items && proj) metas = metas.filter(c => c.projectId === proj);
  // el chat recién creado (sin guardar aún) se muestra arriba
  if (!items && state.currentChat && !metas.some(c => c.id === state.currentChat.id) &&
      (!proj || state.currentChat.projectId === proj)) {
    metas = [{ id: state.currentChat.id, title: state.currentChat.title }, ...metas];
  }
  for (const meta of metas) {
    const el = document.createElement('div');
    el.className = 'chat-item' + (meta.id === state.currentChat?.id ? ' active' : '');
    const title = document.createElement('span');
    title.className = 'title';
    title.innerHTML = escapeHtml(meta.title) +
      (meta.snippet ? `<span class="snippet">${escapeHtml(meta.snippet)}</span>` : '');
    const del = document.createElement('span');
    del.className = 'del';
    del.textContent = '✕';
    del.title = 'Eliminar conversación';
    del.onclick = e => { e.stopPropagation(); deleteChat(meta.id); };
    el.append(title, del);
    el.onclick = () => {
      if (meta.id === state.currentChat?.id) return;
      openChat(meta.id);
    };
    list.appendChild(el);
  }
}

// ---------- Renderizado de mensajes ----------

function msgEl(role, html, label) {
  const div = document.createElement('div');
  div.className = 'msg ' + role;
  div.innerHTML = `
    <div class="avatar">${role === 'user' ? '👤' : '🤖'}</div>
    <div style="flex:1;min-width:0">
      <div class="role-name">${label || (role === 'user' ? 'Tú' : modelLabel())}
        ${role === 'assistant' ? '<button class="copy-btn" title="Copiar texto">📋</button>' : ''}
      </div>
      <div class="bubble">${html}</div>
    </div>`;
  const copyBtn = div.querySelector('.copy-btn');
  if (copyBtn) {
    copyBtn.onclick = () => {
      navigator.clipboard.writeText(div.querySelector('.bubble').innerText).then(() => {
        copyBtn.textContent = '✓';
        setTimeout(() => { copyBtn.textContent = '📋'; }, 1200);
      });
    };
  }
  return div;
}

function modelLabel() {
  const p = $('sel-provider').value;
  const m = currentModel();
  return (state.config?.providers?.[p]?.name || p) + (m ? ' · ' + m : '');
}

function toolCardEl(id, name, args) {
  const div = document.createElement('div');
  div.className = 'tool-card';
  div.dataset.toolId = id;
  div.innerHTML = `
    <div class="tool-head">
      <span>🔧</span>
      <span class="tool-name">${escapeHtml(name)}</span>
      <span class="tool-status">ejecutando…</span>
    </div>
    <pre class="tool-args">${escapeHtml(JSON.stringify(args, null, 2))}</pre>`;
  return div;
}

const WELCOME_HTML = $('welcome').outerHTML;

function renderMessages() {
  const cont = $('messages');
  cont.innerHTML = '';
  if (!state.currentChat || !state.currentChat.messages.length) {
    cont.innerHTML = WELCOME_HTML;
    updateToolbar();
    return;
  }
  state.currentChat.messages.forEach((m, idx) => {
    if (m.role === 'system') return;
    if (m.role === 'user') {
      const el = msgEl('user', renderParts(m.content));
      addEditButton(el, idx);
      cont.appendChild(el);
    }
    else if (m.role === 'assistant') {
      if (m.content && (!Array.isArray(m.content) || m.content.length)) {
        cont.appendChild(msgEl('assistant', renderParts(m.content), m.label));
      }
      for (const tc of m.tool_calls || []) {
        let args = {};
        try { args = JSON.parse(tc.function.arguments); } catch {}
        const card = toolCardEl(tc.id, tc.function.name, args);
        card.querySelector('.tool-status').textContent = '';
        cont.appendChild(card);
      }
    } else if (m.role === 'tool') {
      const card = cont.querySelector(`[data-tool-id="${CSS.escape(m.tool_call_id)}"]`);
      if (card) {
        const st = card.querySelector('.tool-status');
        st.textContent = '✓ completado'; st.classList.add('ok');
        const det = document.createElement('details');
        det.innerHTML = `<summary>Ver resultado</summary><pre>${escapeHtml(String(m.content).slice(0, 4000))}</pre>`;
        card.appendChild(det);
      }
    }
  });
  cont.scrollTop = cont.scrollHeight;
  updateToolbar();
}

// ---------- Edición de mensajes del usuario ----------

function addEditButton(el, msgIndex) {
  const btn = document.createElement('button');
  btn.className = 'copy-btn';
  btn.textContent = '✏';
  btn.title = 'Editar y reenviar desde aquí';
  el.querySelector('.role-name').appendChild(btn);
  btn.onclick = () => startEditMessage(el, msgIndex);
}

function startEditMessage(el, idx) {
  if (state.streaming) return;
  const chat = state.currentChat;
  const msg = chat.messages[idx];
  const original = typeof msg.content === 'string'
    ? msg.content
    : (msg.content || []).filter(p => p.type === 'text').map(p => p.text).join('\n');
  const bubble = el.querySelector('.bubble');
  bubble.innerHTML = '';
  const ta = document.createElement('textarea');
  ta.value = original;
  ta.rows = Math.min(8, Math.max(2, original.split('\n').length));
  ta.style.width = '100%';
  const btns = document.createElement('div');
  btns.className = 'approval-buttons';
  const save = document.createElement('button');
  save.className = 'approve';
  save.textContent = '✓ Guardar y reenviar';
  const cancel = document.createElement('button');
  cancel.className = 'reject';
  cancel.textContent = 'Cancelar';
  btns.append(save, cancel);
  bubble.append(ta, btns);
  ta.focus();
  cancel.onclick = () => renderMessages();
  save.onclick = async () => {
    const nuevo = ta.value.trim();
    if (!nuevo) return;
    if (Array.isArray(msg.content)) {
      // conservar los adjuntos, reemplazar solo el texto
      const media = msg.content.filter(p => p.type !== 'text');
      msg.content = [{ type: 'text', text: nuevo }, ...media];
    } else {
      msg.content = nuevo;
    }
    chat.messages = chat.messages.slice(0, idx + 1); // descartar lo posterior
    saveChats();
    renderChatList();
    renderMessages();
    await runTurn(chat);
  };
}

function updateToolbar() {
  const chat = state.currentChat;
  const has = !!(chat && chat.messages.length);
  $('chat-toolbar').classList.toggle('hidden', !has);
  if (!has) return;
  $('chat-title').textContent = chat.title;
  $('btn-export-md').href = '/api/chats/' + encodeURIComponent(chat.id) + '/export?format=md';
  $('btn-export-json').href = '/api/chats/' + encodeURIComponent(chat.id) + '/export?format=json';
  $('btn-regenerate').style.display = chat.messages.some(m => m.role === 'assistant') ? '' : 'none';
}

// ---------- Envío ----------

function currentModel() {
  return $('inp-model-manual').value.trim() || $('sel-model').value;
}

function setStreaming(on) {
  state.streaming = on;
  $('btn-send').classList.toggle('hidden', on);
  $('btn-stop').classList.toggle('hidden', !on);
}

function errorCard(message) {
  const div = document.createElement('div');
  div.className = 'error-card';
  div.textContent = '⚠ ' + message;
  $('messages').appendChild(div);
  $('messages').scrollTop = $('messages').scrollHeight;
}

async function sendMessage() {
  const text = $('inp-message').value.trim();
  const mode = $('sel-mode').value;
  if (state.streaming) return;
  if (!text && mode !== 'stt') return;
  const provider = $('sel-provider').value;
  const model = currentModel();
  if (!model) { alert('Selecciona o escribe un modelo primero.'); return; }
  if (!state.currentChat) newChat();

  if (mode === 'image') return generateMedia('image', { provider, model, prompt: text });
  if (mode === 'tts') return generateMedia('tts', { provider, model, input: text, voice: $('inp-voice').value.trim() || 'alloy' });
  if (mode === 'stt') return transcribeAudio({ provider, model, note: text });

  const chat = state.currentChat;
  chat.messages.push({ role: 'user', content: buildUserContent(text) });
  chat.settings = { provider, model, agentMode: $('chk-agent').checked, ragId: $('sel-rag').value || '' };
  if (chat.title === 'Nueva conversación') chat.title = (text || state.attachments[0]?.name || 'Adjunto').slice(0, 45);
  $('inp-message').value = '';
  state.attachments = [];
  renderAttachments();
  saveChats(); renderChatList(); renderMessages();

  fetch('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lastProvider: provider, lastModel: model }) }).catch(() => {});

  await runTurn(chat);
}

// Regenera la última respuesta: recorta el historial hasta el último mensaje
// del usuario y vuelve a lanzar el turno
async function regenerateLast() {
  const chat = state.currentChat;
  if (!chat || state.streaming) return;
  let lastUser = -1;
  for (let i = chat.messages.length - 1; i >= 0; i--) {
    if (chat.messages[i].role === 'user') { lastUser = i; break; }
  }
  if (lastUser < 0) return;
  chat.messages = chat.messages.slice(0, lastUser + 1);
  saveChats(); renderChatList(); renderMessages();
  await runTurn(chat);
}

// Ejecuta un turno del modelo (streaming SSE) sobre el historial del chat
async function runTurn(chat) {
  const provider = $('sel-provider').value;
  const model = currentModel();
  setStreaming(true);
  const cont = $('messages');
  let liveBubble = null;
  let liveText = '';

  const ensureBubble = () => {
    if (!liveBubble) {
      const el = msgEl('assistant', '');
      liveBubble = el.querySelector('.bubble');
      liveBubble.classList.add('typing');
      cont.appendChild(el);
    }
  };

  state.abortController = new AbortController();
  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider, model,
        messages: chat.messages,
        agentMode: $('chk-agent').checked,
        ragId: $('sel-rag').value || undefined,
        projectId: chat.projectId || undefined
      }),
      signal: state.abortController.signal
    });

    if (!res.ok || !res.body) {
      throw new Error('HTTP ' + res.status + ': ' + (await res.text()).slice(0, 300));
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const raw = buf.slice(0, idx); buf = buf.slice(idx + 2);
        const line = raw.split('\n').find(l => l.startsWith('data: '));
        if (!line) continue;
        let ev;
        try { ev = JSON.parse(line.slice(6)); } catch { continue; }
        handleEvent(ev);
      }
    }

    function handleEvent(ev) {
      // Si el usuario cambió a otra conversación mientras esta responde, no
      // pintar en la vista equivocada; los mensajes se guardan igualmente
      if (state.currentChat !== chat && ev.type !== 'done') return;
      switch (ev.type) {
        case 'text':
          ensureBubble();
          liveText += ev.text;
          liveBubble.innerHTML = renderMarkdown(liveText);
          liveBubble.classList.add('typing');
          cont.scrollTop = cont.scrollHeight;
          break;
        case 'tool_call': {
          if (liveBubble) { liveBubble.classList.remove('typing'); liveBubble = null; liveText = ''; }
          cont.appendChild(toolCardEl(ev.id, ev.name, ev.args));
          cont.scrollTop = cont.scrollHeight;
          break;
        }
        case 'approval_request': {
          const card = cont.querySelector(`[data-tool-id="${CSS.escape(ev.id)}"]`);
          if (!card) break;
          card.querySelector('.tool-status').textContent = '⏸ esperando tu aprobación';
          const btns = document.createElement('div');
          btns.className = 'approval-buttons';
          const ok = document.createElement('button');
          ok.className = 'approve'; ok.textContent = '✓ Aprobar';
          const no = document.createElement('button');
          no.className = 'reject'; no.textContent = '✕ Rechazar';
          const decide = approved => {
            btns.remove();
            card.querySelector('.tool-status').textContent = approved ? 'ejecutando…' : '✕ rechazado';
            if (!approved) card.querySelector('.tool-status').classList.add('rejected');
            fetch('/api/approval', { method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ id: ev.id, approved }) });
          };
          ok.onclick = () => decide(true);
          no.onclick = () => decide(false);
          btns.append(ok, no);
          card.appendChild(btns);
          cont.scrollTop = cont.scrollHeight;
          break;
        }
        case 'tool_result': {
          const card = cont.querySelector(`[data-tool-id="${CSS.escape(ev.id)}"]`);
          if (!card) break;
          const st = card.querySelector('.tool-status');
          if (ev.approved) { st.textContent = '✓ completado'; st.classList.add('ok'); }
          const det = document.createElement('details');
          det.innerHTML = `<summary>Ver resultado</summary><pre>${escapeHtml(ev.result || '')}</pre>`;
          card.appendChild(det);
          cont.scrollTop = cont.scrollHeight;
          break;
        }
        case 'media': {
          if (liveBubble) { liveBubble.classList.remove('typing'); liveBubble = null; liveText = ''; }
          cont.appendChild(msgEl('assistant', renderParts(ev.content)));
          cont.scrollTop = cont.scrollHeight;
          break;
        }
        case 'error':
          errorCard(ev.message);
          break;
        case 'done':
          // El servidor devuelve los mensajes canónicos generados en este turno
          if (Array.isArray(ev.messages)) chat.messages.push(...ev.messages);
          saveChats();
          break;
      }
    }
  } catch (err) {
    if (err.name !== 'AbortError') errorCard(err.message);
  } finally {
    if (liveBubble) liveBubble.classList.remove('typing');
    setStreaming(false);
    state.abortController = null;
    renderChatList();
    updateToolbar();
  }
}

// ---------- Generación multimedia ----------

async function generateMedia(kind, opts) {
  const chat = state.currentChat;
  const promptText = kind === 'image' ? opts.prompt : opts.input;
  chat.messages.push({ role: 'user', content: (kind === 'image' ? '🖼️ ' : '🔊 ') + promptText });
  if (chat.title === 'Nueva conversación') chat.title = promptText.slice(0, 45);
  $('inp-message').value = '';
  saveChats(); renderChatList(); renderMessages();
  setStreaming(true);
  try {
    const endpoint = kind === 'image' ? '/api/generate/image' : '/api/generate/speech';
    const res = await fetch(endpoint, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(opts)
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    const label = kind === 'image' ? 'Imagen generada' : 'Audio generado';
    const parts = [{ type: 'text', text: `**${label}** — “${promptText.slice(0, 120)}”` }];
    if (kind === 'image') parts.push({ type: 'image_url', image_url: { url: data.ref } });
    else parts.push({ type: 'input_audio', input_audio: { data: data.ref, format: 'mp3' } });
    chat.messages.push({ role: 'assistant', generated: true, label: modelLabel(), content: parts });
    saveChats(); renderMessages();
  } catch (err) {
    errorCard(err.message);
  } finally {
    setStreaming(false);
  }
}

async function transcribeAudio({ provider, model, note }) {
  const audio = state.attachments.find(a => a.kind === 'audio') || state.attachments.find(a => a.kind === 'video');
  if (!audio) { alert('Adjunta primero un archivo de audio con 📎 para transcribirlo.'); return; }
  const chat = state.currentChat;
  chat.messages.push({ role: 'user', content: `📝 Transcribir: ${audio.name}` + (note ? ` — ${note}` : '') });
  if (chat.title === 'Nueva conversación') chat.title = 'Transcripción: ' + audio.name.slice(0, 30);
  $('inp-message').value = '';
  state.attachments = state.attachments.filter(a => a !== audio);
  renderAttachments();
  saveChats(); renderChatList(); renderMessages();
  setStreaming(true);
  try {
    const res = await fetch('/api/transcribe', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider, model, ref: audio.ref })
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    chat.messages.push({
      role: 'assistant', generated: true, label: modelLabel(),
      content: [{ type: 'text', text: '**Transcripción de ' + audio.name + ':**\n\n' + data.text }]
    });
    saveChats(); renderMessages();
  } catch (err) {
    errorCard(err.message);
  } finally {
    setStreaming(false);
  }
}

// ---------- Proveedores y modelos ----------

const GROUP_LABELS = { local: '💻 Locales', free: '🎁 Nube — con nivel gratuito', paid: '💳 Nube — de pago' };

async function loadConfig() {
  state.config = await (await fetch('/api/config')).json();
  const sel = $('sel-provider');
  sel.innerHTML = '';
  const byGroup = {};
  for (const [id, p] of Object.entries(state.config.providers)) {
    (byGroup[p.group] ??= []).push([id, p]);
  }
  for (const g of ['local', 'free', 'paid']) {
    if (!byGroup[g]) continue;
    const og = document.createElement('optgroup');
    og.label = GROUP_LABELS[g];
    for (const [id, p] of byGroup[g]) {
      const opt = document.createElement('option');
      opt.value = id;
      opt.textContent = p.name + (p.needsKey && !p.hasKey ? ' (sin key)' : '');
      og.appendChild(opt);
    }
    sel.appendChild(og);
  }
  if (state.config.lastProvider && state.config.providers[state.config.lastProvider]) {
    sel.value = state.config.lastProvider;
  }
  const gwEl = $('gw-url');
  if (gwEl) gwEl.textContent = state.config.gatewayUrl;
  renderProjectSelect();
  await loadModels(state.config.lastModel);
}

async function loadModels(preselect) {
  const provider = $('sel-provider').value;
  const sel = $('sel-model');
  sel.innerHTML = '<option>cargando…</option>';
  try {
    const res = await fetch('/api/models?provider=' + encodeURIComponent(provider));
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    sel.innerHTML = '';
    for (const m of data.models) {
      const opt = document.createElement('option');
      opt.value = m; opt.textContent = m;
      sel.appendChild(opt);
    }
    if (!data.models.length) sel.innerHTML = '<option value="">(sin modelos)</option>';
    if (preselect && data.models.includes(preselect)) sel.value = preselect;
  } catch (err) {
    const p = state.config?.providers?.[provider];
    let msg = err.message || 'error';
    if (p?.local && /fetch failed|ECONNREFUSED/i.test(msg)) {
      msg = provider === 'lmstudio'
        ? 'LM Studio apagado — Developer → Start Server'
        : 'Ollama apagado — ejecuta "ollama serve"';
    } else if (/Falta la API key/i.test(msg)) {
      msg = 'añade la API key en ⚙ Ajustes';
    }
    sel.innerHTML = `<option value="">(${escapeHtml(msg).slice(0, 70)})</option>`;
  }
  updateCaps();
}

async function refreshLocalStatus() {
  try {
    const st = await (await fetch('/api/status')).json();
    for (const id of ['ollama', 'lmstudio', 'sd', 'comfy']) {
      const dot = $('dot-' + id), detail = $('detail-' + id);
      if (!dot || !st[id]) continue;
      dot.className = 'dot ' + (st[id].online ? 'on' : 'off');
      detail.textContent = st[id].online ? (st[id].models?.length || 0) + ' modelos' : 'apagado';
    }
  } catch { /* servidor reiniciándose */ }
}

// ---------- Modal de ajustes ----------

function renderMcpStatus(servers) {
  const cont = $('mcp-status');
  if (!servers.length) {
    cont.innerHTML = '<p class="hint">Sin conectores configurados o aún no arrancados (se arrancan al usar el modo agente, o con ⟳ probar).</p>';
    return;
  }
  cont.innerHTML = servers.map(s => {
    const dot = s.status === 'ok' ? '🟢' : s.status === 'iniciando' ? '🟡' : '🔴';
    const detail = s.status === 'ok'
      ? s.tools + ' herramientas'
      : escapeHtml((s.error || s.status).slice(0, 160));
    return `<p class="hint">${dot} <b>${escapeHtml(s.name)}</b> — ${detail}</p>`;
  }).join('');
}

async function refreshMcpStatus(reload) {
  try {
    const res = await fetch('/api/mcp/' + (reload ? 'reload' : 'status'), reload ? { method: 'POST' } : undefined);
    renderMcpStatus((await res.json()).servers || []);
  } catch { /* servidor ocupado */ }
}

function openSettings() {
  const c = state.config;
  $('cfg-lang').value = dedlitLang();
  $('cfg-autoupdate').checked = c.autoUpdateCheck !== false;
  $('cfg-version').textContent = 'v' + (c.version || '?');
  $('cfg-ghtoken').placeholder = c.hasUpdateToken
    ? '●●●●●●●● token guardado — escribe para reemplazar; un guion (-) para borrar'
    : 'Token de GitHub — solo necesario mientras el repo sea privado';
  $('cfg-workspace').value = c.workspace;
  $('cfg-lmdir').value = c.lmstudioModelsDir || '';
  $('cfg-lmdir').placeholder = c.lmstudioModelsDirDefault || '~/.lmstudio/models';
  $('cfg-sdurl').value = c.sdWebuiUrl || '';
  $('cfg-comfy').value = c.comfyUrl || '';
  $('cfg-stt').value = c.sttUrl || '';
  $('cfg-tts').value = c.ttsUrl || '';
  $('cfg-instructions').value = c.customInstructions || '';
  $('cfg-auto-read').checked = c.autoApprove.read;
  $('cfg-auto-write').checked = c.autoApprove.write;
  $('cfg-auto-command').checked = c.autoApprove.command;
  $('cfg-auto-network').checked = !!c.autoApprove.network;
  $('cfg-mcp').value = JSON.stringify(c.mcpServers || {}, null, 2);
  refreshMcpStatus(false);
  $('cfg-gateway').textContent = c.gatewayUrl;

  const cont = $('cfg-providers');
  cont.innerHTML = '';
  for (const [id, p] of Object.entries(c.providers)) {
    const div = document.createElement('div');
    div.className = 'provider-cfg';
    const badge = p.local
      ? '<span class="badge local">local</span>'
      : (p.hasKey ? '<span class="badge key-ok">key configurada</span>' : '<span class="badge key-missing">sin key</span>');
    const keyPlaceholder = p.hasKey
      ? '●●●●●●●● guardada — escribe para reemplazar; un guion (-) para borrar'
      : 'API key — vacío: no cambiar; un guion (-): borrar';
    const keyLink = p.needsKey && p.keyUrl
      ? `<span class="key-link"><a href="${escapeHtml(p.keyUrl)}" target="_blank" rel="noopener">obtener API key ↗</a></span>` : '';
    div.innerHTML = `
      <div class="pname">${escapeHtml(p.name)} ${badge} ${keyLink}</div>
      ${p.needsKey ? `<input type="password" data-key="${id}" placeholder="${keyPlaceholder}" autocomplete="off">` : ''}
      <input type="text" data-base="${id}" value="${escapeHtml(p.baseUrl)}" title="URL base del endpoint (vaciar = restaurar la URL por defecto)">`;
    cont.appendChild(div);
  }
  $('modal-overlay').classList.remove('hidden');
}

async function saveSettings() {
  const keys = {}, baseUrls = {};
  document.querySelectorAll('[data-key]').forEach(inp => {
    const v = inp.value.trim();
    if (!v) keys[inp.dataset.key] = null;          // vacío = no cambiar
    else if (v === '-') keys[inp.dataset.key] = ''; // "-" = borrar
    else keys[inp.dataset.key] = v;
  });
  // token de GitHub para actualizaciones (mismo convenio vacío/-)
  const ghTok = $('cfg-ghtoken').value.trim();
  if (ghTok) keys.ghupdate = ghTok === '-' ? '' : ghTok;
  document.querySelectorAll('[data-base]').forEach(inp => {
    baseUrls[inp.dataset.base] = inp.value.trim(); // '' = restaurar por defecto
  });
  let mcpServers;
  try {
    mcpServers = JSON.parse($('cfg-mcp').value.trim() || '{}');
    if (typeof mcpServers !== 'object' || Array.isArray(mcpServers)) throw new Error('debe ser un objeto {nombre: {command, args}}');
  } catch (err) {
    alert('El JSON de conectores MCP no es válido: ' + err.message);
    return;
  }
  const btn = $('btn-save-config');
  btn.disabled = true;
  btn.textContent = 'Guardando…';
  try {
    const res = await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workspace: $('cfg-workspace').value.trim(),
        autoUpdateCheck: $('cfg-autoupdate').checked,
        lmstudioModelsDir: $('cfg-lmdir').value.trim(),
        sdWebuiUrl: $('cfg-sdurl').value.trim(),
        comfyUrl: $('cfg-comfy').value.trim(),
        sttUrl: $('cfg-stt').value.trim(),
        ttsUrl: $('cfg-tts').value.trim(),
        customInstructions: $('cfg-instructions').value,
        autoApprove: {
          read: $('cfg-auto-read').checked,
          write: $('cfg-auto-write').checked,
          command: $('cfg-auto-command').checked,
          network: $('cfg-auto-network').checked
        },
        keys, baseUrls, mcpServers
      })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) throw new Error(data.error || 'HTTP ' + res.status);
    await loadConfig();
    refreshLocalStatus();
    fetch('/api/mcp/reload', { method: 'POST' }).catch(() => {}); // arrancar conectores en segundo plano
    btn.textContent = '✓ Guardado';
    setTimeout(() => {
      $('modal-overlay').classList.add('hidden');
      btn.textContent = 'Guardar';
      btn.disabled = false;
    }, 600);
  } catch (err) {
    btn.textContent = 'Guardar';
    btn.disabled = false;
    alert('No se pudo guardar la configuración: ' + err.message);
  }
}

// ---------- Auto-actualización ----------

async function checkForUpdate() {
  try {
    const info = await (await fetch('/api/update/check')).json();
    if (info.error || !info.hasUpdate) return;
    const banner = $('update-banner');
    $('update-text').innerHTML = `🆕 Nueva versión <b>v${escapeHtml(info.latest)}</b> disponible (tienes v${escapeHtml(info.current)})`;
    $('update-notes').href = info.url;
    $('btn-update-install').style.display = info.canAutoInstall ? '' : 'none';
    if (!info.canAutoInstall) {
      $('update-text').innerHTML += ' — descárgala desde GitHub';
    }
    banner.classList.remove('hidden');
  } catch { /* sin red o repo inaccesible: silencio */ }
}

async function installUpdate() {
  const banner = $('update-banner');
  banner.innerHTML = '<span id="update-text">⬇ Descargando actualización…</span><div class="bar"><div style="width:0%"></div></div>';
  const text = banner.querySelector('#update-text');
  const bar = banner.querySelector('.bar > div');
  try {
    const res = await fetch('/api/update/install', { method: 'POST' });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const line = buf.slice(0, i).split('\n').find(l => l.startsWith('data: '));
        buf = buf.slice(i + 2);
        if (!line) continue;
        const ev = JSON.parse(line.slice(6));
        if (ev.type === 'progress') {
          bar.style.width = ev.pct + '%';
          text.textContent = `⬇ Descargando actualización… ${ev.pct}% (${ev.mb} MB)`;
        } else if (ev.type === 'done') {
          bar.style.width = '100%';
          text.textContent = '♻ ' + ev.note + ' La página se recargará sola.';
          waitForRestart();
        } else if (ev.type === 'error') {
          throw new Error(ev.message);
        }
      }
    }
  } catch (err) {
    // si el servidor se apagó a mitad del stream, es el reinicio esperado
    if (String(err.message).includes('network') || String(err.message).includes('Failed to fetch')) {
      waitForRestart();
    } else {
      text.textContent = '⚠ ' + err.message;
    }
  }
}

function waitForRestart() {
  let attempts = 0;
  const timer = setInterval(async () => {
    attempts++;
    try {
      const r = await fetch('/api/config', { cache: 'no-store' });
      if (r.ok) { clearInterval(timer); location.reload(); }
    } catch { /* aún reiniciando */ }
    if (attempts > 60) clearInterval(timer);
  }, 2000);
}

// ---------- Proyectos ----------

let editingProjectId = null;

function projectFilter() {
  return $('sel-project').value;
}

function renderProjectSelect() {
  const sel = $('sel-project');
  const current = localStorage.getItem('dedlit.project') || '';
  sel.innerHTML = '<option value="">📁 Todos</option>';
  for (const p of state.config?.projects || []) {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = '📁 ' + p.name;
    sel.appendChild(opt);
  }
  if ([...sel.options].some(o => o.value === current)) sel.value = current;
}

async function openProjects() {
  editingProjectId = null;
  $('proj-form-title').textContent = 'Nuevo proyecto';
  $('proj-name').value = '';
  $('proj-instructions').value = '';
  // colecciones RAG disponibles para el select
  const collections = await loadRagCollections();
  const sel = $('proj-rag');
  sel.innerHTML = '<option value="">(sin documentos por defecto)</option>';
  for (const c of collections) {
    const opt = document.createElement('option');
    opt.value = c.id;
    opt.textContent = '📚 ' + c.name;
    sel.appendChild(opt);
  }
  renderProjList();
  $('proj-overlay').classList.remove('hidden');
}

function renderProjList() {
  const cont = $('proj-list');
  const projects = state.config?.projects || [];
  if (!projects.length) {
    cont.innerHTML = '<p class="hint">Aún no hay proyectos.</p>';
    return;
  }
  cont.innerHTML = '';
  for (const p of projects) {
    const div = document.createElement('div');
    div.className = 'provider-cfg';
    div.innerHTML = `
      <div class="pname">📁 ${escapeHtml(p.name)}
        <span class="key-link" style="margin-left:auto"><a href="#" data-edit="${p.id}">editar</a> · <a href="#" data-del="${p.id}">borrar</a></span>
      </div>
      ${p.instructions ? `<p class="hint">${escapeHtml(p.instructions.slice(0, 120))}${p.instructions.length > 120 ? '…' : ''}</p>` : ''}`;
    div.querySelector('[data-edit]').onclick = e => {
      e.preventDefault();
      editingProjectId = p.id;
      $('proj-form-title').textContent = 'Editar «' + p.name + '»';
      $('proj-name').value = p.name;
      $('proj-instructions').value = p.instructions || '';
      $('proj-rag').value = p.ragId || '';
    };
    div.querySelector('[data-del]').onclick = async e => {
      e.preventDefault();
      await saveProjects(state.config.projects.filter(x => x.id !== p.id));
      renderProjList();
      renderProjectSelect();
      renderChatList();
    };
    cont.appendChild(div);
  }
}

async function saveProjects(projects) {
  state.config.projects = projects;
  await fetch('/api/config', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projects })
  }).catch(() => {});
}

async function saveProjectForm() {
  const name = $('proj-name').value.trim();
  if (!name) { alert('Pon un nombre al proyecto.'); return; }
  const data = {
    id: editingProjectId || Date.now().toString(36),
    name,
    instructions: $('proj-instructions').value.trim(),
    ragId: $('proj-rag').value
  };
  const projects = [...(state.config.projects || [])];
  const i = projects.findIndex(p => p.id === data.id);
  if (i >= 0) projects[i] = data; else projects.push(data);
  await saveProjects(projects);
  editingProjectId = null;
  $('proj-form-title').textContent = 'Nuevo proyecto';
  $('proj-name').value = '';
  $('proj-instructions').value = '';
  $('proj-rag').value = '';
  renderProjList();
  renderProjectSelect();
}

// ---------- Plantillas de prompts ----------

function openTemplates() {
  renderTplList();
  $('tpl-overlay').classList.remove('hidden');
}

function renderTplList() {
  const cont = $('tpl-list');
  const tpls = state.config?.promptTemplates || [];
  if (!tpls.length) {
    cont.innerHTML = '<p class="hint">Aún no tienes plantillas guardadas.</p>';
    return;
  }
  cont.innerHTML = '';
  tpls.forEach((t, i) => {
    const div = document.createElement('div');
    div.className = 'provider-cfg';
    div.innerHTML = `
      <div class="pname">${escapeHtml(t.name)}
        <span class="key-link" style="margin-left:auto"><a href="#" data-use="${i}">usar</a> · <a href="#" data-del="${i}">borrar</a></span>
      </div>
      <p class="hint">${escapeHtml(t.text.slice(0, 140))}${t.text.length > 140 ? '…' : ''}</p>`;
    div.querySelector('[data-use]').onclick = e => { e.preventDefault(); useTemplate(t); };
    div.querySelector('[data-del]').onclick = async e => {
      e.preventDefault();
      const tpls2 = state.config.promptTemplates.filter((_, j) => j !== i);
      await saveTemplates(tpls2);
      renderTplList();
    };
    cont.appendChild(div);
  });
}

function useTemplate(t) {
  let text = t.text;
  // rellenar los huecos {{campo}} preguntando cada valor
  const fields = [...new Set([...text.matchAll(/\{\{([^}]+)\}\}/g)].map(m => m[1]))];
  for (const f of fields) {
    const val = prompt('Valor para «' + f + '»:');
    if (val === null) return;
    text = text.split('{{' + f + '}}').join(val);
  }
  $('tpl-overlay').classList.add('hidden');
  const inp = $('inp-message');
  inp.value = inp.value ? inp.value + '\n' + text : text;
  inp.focus();
}

async function saveTemplates(tpls) {
  state.config.promptTemplates = tpls;
  await fetch('/api/config', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ promptTemplates: tpls })
  }).catch(() => {});
}

async function addTemplate() {
  const name = $('tpl-name').value.trim();
  const text = $('tpl-text').value.trim();
  if (!name || !text) { alert('Pon nombre y texto a la plantilla.'); return; }
  await saveTemplates([...(state.config.promptTemplates || []), { name, text }]);
  $('tpl-name').value = '';
  $('tpl-text').value = '';
  renderTplList();
}

// ---------- Documentos (RAG local) ----------

async function loadRagCollections() {
  try {
    const { collections } = await (await fetch('/api/rag')).json();
    const sel = $('sel-rag');
    const current = sel.value;
    sel.innerHTML = '<option value="">(sin contexto documental)</option>';
    for (const c of collections || []) {
      const opt = document.createElement('option');
      opt.value = c.id;
      opt.textContent = '📚 ' + c.name + ' (' + c.chunks + ' fragmentos)';
      sel.appendChild(opt);
    }
    if ([...sel.options].some(o => o.value === current)) sel.value = current;
    return collections || [];
  } catch {
    return [];
  }
}

async function openDocs() {
  $('docs-overlay').classList.remove('hidden');
  // proveedor de embeddings: locales primero
  const sel = $('docs-provider');
  sel.innerHTML = '';
  for (const [id, p] of Object.entries(state.config.providers)) {
    if (id === 'anthropic') continue; // sin endpoint de embeddings
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = p.name;
    sel.appendChild(opt);
  }
  if (!$('docs-model').value) $('docs-model').placeholder = 'p. ej. text-embedding-nomic-embed-text-v1.5';
  renderDocsList(await loadRagCollections());
}

function renderDocsList(collections) {
  const cont = $('docs-list');
  if (!collections.length) {
    cont.innerHTML = '<p class="hint">Aún no hay colecciones indexadas.</p>';
    return;
  }
  cont.innerHTML = '';
  for (const c of collections) {
    const div = document.createElement('div');
    div.className = 'provider-cfg';
    div.innerHTML = `
      <div class="pname">📚 ${escapeHtml(c.name)}
        <span class="badge local">${c.chunks} fragmentos · ${c.files} archivos</span>
        <span class="key-link" style="margin-left:auto"><a href="#" data-del="${c.id}">eliminar</a></span>
      </div>
      <p class="hint">${escapeHtml(c.folder)} — embeddings: ${escapeHtml(c.provider)}:${escapeHtml(c.model)}</p>`;
    div.querySelector('[data-del]').onclick = async e => {
      e.preventDefault();
      await fetch('/api/rag/' + c.id, { method: 'DELETE' });
      renderDocsList(await loadRagCollections());
    };
    cont.appendChild(div);
  }
}

async function indexDocs() {
  const name = $('docs-name').value.trim();
  const folder = $('docs-folder').value.trim();
  const provider = $('docs-provider').value;
  const model = $('docs-model').value.trim();
  const prog = $('docs-progress');
  if (!name || !folder || !model) { alert('Rellena nombre, carpeta y modelo de embeddings.'); return; }
  const btn = $('btn-docs-index');
  btn.disabled = true;
  prog.textContent = 'Escaneando y extrayendo texto…';
  try {
    const res = await fetch('/api/rag/index', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, folder, provider, model })
    });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const line = buf.slice(0, i).split('\n').find(l => l.startsWith('data: '));
        buf = buf.slice(i + 2);
        if (!line) continue;
        const ev = JSON.parse(line.slice(6));
        if (ev.type === 'progress') prog.textContent = `Calculando embeddings… ${ev.done}/${ev.total} fragmentos`;
        else if (ev.type === 'done') {
          prog.textContent = `✓ "${ev.name}" indexada: ${ev.files} archivos, ${ev.chunks} fragmentos.`;
          $('docs-name').value = ''; $('docs-folder').value = '';
          renderDocsList(await loadRagCollections());
        } else if (ev.type === 'error') throw new Error(ev.message);
      }
    }
  } catch (err) {
    prog.textContent = '⚠ ' + err.message;
  } finally {
    btn.disabled = false;
  }
}

// ---------- Buscador de modelos (Hugging Face) ----------

const LIGHT = { green: '🟢', yellow: '🟡', red: '🔴' };

async function openHub() {
  $('hub-overlay').classList.remove('hidden');
  $('hub-query').focus();
  try {
    const sys = await (await fetch('/api/system')).json();
    const gpuTxt = sys.gpus.length
      ? sys.gpus.map(g => `${g.name} (${g.vramGB} GB VRAM)`).join(' + ')
      : 'sin GPU dedicada detectada';
    $('hub-system').innerHTML = `💾 RAM: <b>${sys.ramGB} GB</b> &nbsp;·&nbsp; 🎮 ${escapeHtml(gpuTxt)}` +
      (sys.unified ? ' · memoria unificada' : '');
  } catch {
    $('hub-system').textContent = 'No se pudo detectar el hardware';
  }
}

async function hubSearch() {
  const q = $('hub-query').value.trim();
  if (!q) return;
  const cont = $('hub-results');
  cont.innerHTML = '<p class="hint">Buscando en Hugging Face…</p>';
  try {
    const res = await fetch('/api/hub/search?q=' + encodeURIComponent(q));
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    cont.innerHTML = data.models.length ? '' : '<p class="hint">Sin resultados GGUF para esa búsqueda.</p>';
    for (const m of data.models) {
      const card = document.createElement('div');
      card.className = 'hub-model';
      card.innerHTML = `
        <div class="hm-head">
          <span class="hm-id">${escapeHtml(m.id)}</span>
          <span class="hm-meta">⬇ ${(m.downloads).toLocaleString('es')} · ♥ ${m.likes}</span>
        </div>
        <div class="hub-files hidden"></div>`;
      card.querySelector('.hm-head').onclick = () => hubFiles(m.id, card.querySelector('.hub-files'));
      cont.appendChild(card);
    }
  } catch (err) {
    cont.innerHTML = `<p class="hint">⚠ ${escapeHtml(err.message)}</p>`;
  }
}

async function hubFiles(repo, cont) {
  if (!cont.classList.contains('hidden')) { cont.classList.add('hidden'); return; }
  cont.classList.remove('hidden');
  cont.innerHTML = '<p class="hint">Leyendo archivos…</p>';
  try {
    const res = await fetch('/api/hub/files?repo=' + encodeURIComponent(repo));
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    cont.innerHTML = data.files.length ? '' : '<p class="hint">Este repo no tiene archivos GGUF.</p>';
    for (const f of data.files) {
      const row = document.createElement('div');
      row.className = 'hub-file';
      const multi = f.parts > 1;
      row.innerHTML = `
        <span>${LIGHT[f.verdict.level]}</span>
        <span class="hf-name" title="${escapeHtml(f.file)}">${escapeHtml(f.file)}</span>
        <span class="hf-size">${f.sizeGB} GB${multi ? ` (${f.parts} partes)` : ''}</span>
        <span class="hf-verdict">${escapeHtml(f.verdict.label)} (necesita ~${f.verdict.needGB} GB)</span>
        <span class="hf-actions">
          ${multi ? '' : '<button data-t="lmstudio" title="Descargar a la carpeta de modelos de LM Studio">⬇ LM Studio</button>'}
          <button data-t="ollama" title="Registrar en Ollama (ollama pull hf.co/…); gestiona multiparte automáticamente">⬇ Ollama</button>
        </span>`;
      row.querySelectorAll('.hf-actions button').forEach(btn => {
        btn.onclick = () => hubDownload(repo, f.file, btn.dataset.t, row);
      });
      cont.appendChild(row);
    }
  } catch (err) {
    cont.innerHTML = `<p class="hint">⚠ ${escapeHtml(err.message)}</p>`;
  }
}

async function hubDownload(repo, file, target, row) {
  row.querySelector('.hf-actions').classList.add('hidden');
  const prog = document.createElement('div');
  prog.className = 'hub-progress';
  prog.innerHTML = '<span class="ptext">Iniciando descarga…</span><div class="bar"><div style="width:0%"></div></div>';
  row.appendChild(prog);
  const ptext = prog.querySelector('.ptext');
  const bar = prog.querySelector('.bar > div');
  try {
    const res = await fetch('/api/hub/download', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repo, file, target })
    });
    if (!res.ok || !res.body) throw new Error('HTTP ' + res.status);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const line = buf.slice(0, i).split('\n').find(l => l.startsWith('data: '));
        buf = buf.slice(i + 2);
        if (!line) continue;
        const ev = JSON.parse(line.slice(6));
        if (ev.type === 'progress') {
          if (ev.pct !== undefined) bar.style.width = ev.pct + '%';
          ptext.textContent = (ev.pct !== undefined ? ev.pct + '% ' : '') +
            (ev.mb ? `(${ev.mb}/${ev.totalMb} MB)` : '') + (ev.note ? ' ' + ev.note : '');
        } else if (ev.type === 'done') {
          bar.style.width = '100%';
          ptext.textContent = '✓ ' + (ev.note || 'Descargado') + ' — ' + ev.path;
        } else if (ev.type === 'error') {
          throw new Error(ev.message);
        }
      }
    }
  } catch (err) {
    ptext.textContent = '⚠ ' + err.message;
    row.querySelector('.hf-actions').classList.remove('hidden');
  }
}

// ---------- APIs gratuitas ----------

// Resumen curado de servicios con nivel gratuito (fuente y lista completa:
// github.com/cheahjs/free-llm-api-resources). Los límites cambian a menudo.
const FREE_RESOURCES = [
  { id: 'openrouter', icon: '🔀', desc: 'Cientos de modelos de todos los proveedores en un solo sitio; los que llevan sufijo <code>:free</code> no cuestan nada (~50 peticiones/día, más si haces un depósito único).' },
  { id: 'google', icon: '✨', desc: 'Gemini con nivel gratuito generoso vía AI Studio (Flash: cientos de peticiones al día). También genera imágenes. La opción gratuita más completa.' },
  { id: 'groq', icon: '⚡', desc: 'Inferencia ultrarrápida de Llama, Qwen, GPT-OSS y Whisper (transcripción) gratis con límites por minuto y día.' },
  { id: 'mistral', icon: '🌬️', desc: 'La Plateforme tiene tier gratuito experimental (requiere verificar teléfono): todos sus modelos, 1 petición/segundo.' },
  { id: 'cerebras', icon: '🧠', desc: 'Llama, Qwen y GPT-OSS a velocidad récord; nivel gratuito de ~14.000 peticiones/día.' },
  { id: 'githubmodels', icon: '🐙', desc: 'GPT, Llama, DeepSeek, Grok y más gratis con tu cuenta de GitHub: crea un token clásico (PAT) sin permisos extra y úsalo como key.' },
  { id: 'nvidia', icon: '💚', desc: 'NVIDIA NIM: DeepSeek, Llama, Qwen y decenas de modelos abiertos gratis registrándote en build.nvidia.com.' },
  { id: 'huggingface', icon: '🤗', desc: 'Router serverless con multitud de modelos abiertos; crédito mensual gratuito según el tipo de cuenta.' }
];

function openFreeApis() {
  const cont = $('free-list');
  cont.innerHTML = '';
  for (const r of FREE_RESOURCES) {
    const p = state.config?.providers?.[r.id];
    if (!p) continue;
    const card = document.createElement('div');
    card.className = 'free-card';
    const badge = p.hasKey ? '<span class="badge key-ok">key configurada</span>' : '';
    card.innerHTML = `
      <div class="fname">${r.icon} ${escapeHtml(p.name)} ${badge}</div>
      <div class="fdesc">${r.desc}</div>
      <div class="factions">
        <a href="${escapeHtml(p.keyUrl)}" target="_blank" rel="noopener">Obtener API key ↗</a>
        <button data-configure="${r.id}">Pegar la key en Ajustes</button>
      </div>`;
    card.querySelector('[data-configure]').onclick = () => {
      $('free-overlay').classList.add('hidden');
      openSettings();
      const input = document.querySelector(`[data-key="${r.id}"]`);
      if (input) {
        input.scrollIntoView({ block: 'center' });
        input.focus();
      }
    };
    cont.appendChild(card);
  }
  $('free-overlay').classList.remove('hidden');
}

// ---------- Eventos ----------

$('btn-new-chat').onclick = newChat;
$('btn-theme').onclick = toggleTheme;
$('cfg-lang').onchange = () => setLanguage($('cfg-lang').value);
$('btn-update-install').onclick = installUpdate;
$('btn-update-close').onclick = () => $('update-banner').classList.add('hidden');
$('btn-send').onclick = sendMessage;
$('btn-stop').onclick = () => state.abortController?.abort();
$('btn-regenerate').onclick = regenerateLast;

// Búsqueda en el historial (server-side, con retardo al teclear)
let chatSearchTimer;
$('inp-chat-search').addEventListener('input', () => {
  clearTimeout(chatSearchTimer);
  chatSearchTimer = setTimeout(async () => {
    const q = $('inp-chat-search').value.trim();
    if (!q) return renderChatList();
    try {
      const r = await (await fetch('/api/chats/search?q=' + encodeURIComponent(q))).json();
      renderChatList(r.results || []);
    } catch { /* servidor ocupado */ }
  }, 300);
});
$('sel-provider').onchange = () => loadModels();
$('sel-model').onchange = updateCaps;
$('inp-model-manual').oninput = updateCaps;
$('btn-refresh-models').onclick = () => loadModels();
$('btn-settings').onclick = openSettings;
$('btn-mcp-reload').onclick = async e => {
  e.preventDefault();
  const btn = $('btn-mcp-reload');
  btn.textContent = '⏳';
  // guardar primero el JSON del textarea para probar lo que el usuario ve
  try {
    const mcpServers = JSON.parse($('cfg-mcp').value.trim() || '{}');
    await fetch('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mcpServers }) });
    await refreshMcpStatus(true);
  } catch (err) {
    alert('JSON de conectores no válido: ' + err.message);
  }
  btn.textContent = '⟳ probar';
};
$('btn-free-apis').onclick = openFreeApis;
$('btn-hub').onclick = openHub;
$('btn-docs').onclick = openDocs;
$('btn-templates').onclick = openTemplates;
$('btn-projects').onclick = openProjects;
$('btn-close-proj').onclick = () => $('proj-overlay').classList.add('hidden');
$('proj-overlay').onclick = e => { if (e.target.id === 'proj-overlay') $('proj-overlay').classList.add('hidden'); };
$('btn-proj-save').onclick = saveProjectForm;
$('sel-project').onchange = () => {
  localStorage.setItem('dedlit.project', $('sel-project').value);
  renderChatList();
};
$('btn-close-tpl').onclick = () => $('tpl-overlay').classList.add('hidden');
$('tpl-overlay').onclick = e => { if (e.target.id === 'tpl-overlay') $('tpl-overlay').classList.add('hidden'); };
$('btn-tpl-save').onclick = addTemplate;

// Atajos de teclado globales
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    for (const id of ['modal-overlay', 'free-overlay', 'hub-overlay', 'docs-overlay', 'tpl-overlay', 'proj-overlay']) {
      $(id)?.classList.add('hidden');
    }
    return;
  }
  const mod = e.ctrlKey || e.metaKey;
  if (mod && !e.shiftKey && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    $('inp-chat-search').focus();
  } else if (mod && e.shiftKey && e.key.toLowerCase() === 'o') {
    e.preventDefault();
    newChat();
    $('inp-message').focus();
  } else if (mod && e.key === ',') {
    e.preventDefault();
    openSettings();
  } else if (e.altKey && e.key.toLowerCase() === 'a') {
    e.preventDefault();
    $('chk-agent').checked = !$('chk-agent').checked;
  }
});
$('btn-close-docs').onclick = () => $('docs-overlay').classList.add('hidden');
$('docs-overlay').onclick = e => { if (e.target.id === 'docs-overlay') $('docs-overlay').classList.add('hidden'); };
$('btn-docs-index').onclick = indexDocs;
$('btn-close-hub').onclick = () => $('hub-overlay').classList.add('hidden');
$('hub-overlay').onclick = e => { if (e.target.id === 'hub-overlay') $('hub-overlay').classList.add('hidden'); };
$('btn-hub-search').onclick = hubSearch;
$('hub-query').addEventListener('keydown', e => { if (e.key === 'Enter') hubSearch(); });
$('btn-close-free').onclick = () => $('free-overlay').classList.add('hidden');
$('free-overlay').onclick = e => { if (e.target.id === 'free-overlay') $('free-overlay').classList.add('hidden'); };
$('btn-close-modal').onclick = () => $('modal-overlay').classList.add('hidden');
$('btn-save-config').onclick = saveSettings;
$('btn-vscode').onclick = async () => {
  const r = await (await fetch('/api/open-vscode', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json();
  if (r.error) alert('No se pudo abrir VS Code: ' + r.error);
};
$('modal-overlay').onclick = e => { if (e.target.id === 'modal-overlay') $('modal-overlay').classList.add('hidden'); };

$('btn-attach').onclick = () => $('inp-file').click();
$('inp-file').onchange = e => { addFiles([...e.target.files]); e.target.value = ''; };

$('sel-mode').onchange = () => {
  const mode = $('sel-mode').value;
  $('inp-voice').classList.toggle('hidden', mode !== 'tts');
  $('inp-message').placeholder = {
    chat: 'Escribe tu mensaje… (Enter para enviar, Shift+Enter para salto de línea)',
    image: 'Describe la imagen a generar… (Stable Diffusion local si está activo, o gpt-image-1 / grok-2-image / cogview con key)',
    tts: 'Texto a convertir en voz… (modelo: tts-1, gpt-4o-mini-tts…)',
    stt: 'Adjunta un audio con 📎 y pulsa enviar (modelo: whisper-1, gpt-4o-transcribe…)'
  }[mode];
};

$('inp-message').addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
});

// Pegar imágenes desde el portapapeles
$('inp-message').addEventListener('paste', e => {
  const files = [...(e.clipboardData?.items || [])]
    .filter(i => i.kind === 'file')
    .map(i => i.getAsFile())
    .filter(Boolean);
  if (files.length) { e.preventDefault(); addFiles(files); }
});

// Arrastrar y soltar sobre toda la zona principal
const mainEl = $('main');
mainEl.addEventListener('dragover', e => e.preventDefault());
mainEl.addEventListener('drop', e => {
  e.preventDefault();
  if (e.dataTransfer?.files?.length) addFiles([...e.dataTransfer.files]);
});

// ---------- Arranque ----------

(async function init() {
  await loadConfig();
  refreshLocalStatus();
  loadRagCollections();
  if (state.config.autoUpdateCheck !== false) checkForUpdate();
  setInterval(refreshLocalStatus, 15000);
  await migrateLocalChats(); // una sola vez: pasa los chats antiguos del navegador a disco
  await loadChatIndex();
  if (state.chatIndex.length) {
    await openChat(state.chatIndex[0].id);
  } else {
    renderChatList();
    renderMessages();
  }
})();
