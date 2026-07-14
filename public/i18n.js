'use strict';
/* Interfaz multiidioma. El español es el idioma nativo de la app; para otros
   idiomas se traduce el DOM (nodos de texto, placeholder y title) con un
   diccionario y un MutationObserver que cubre el contenido dinámico.
   Volver a español = recargar (los textos originales viven en el HTML). */

const I18N = {
  en: {
    // Barra lateral
    'Proveedor': 'Provider',
    'Modelo': 'Model',
    '…o escribe el modelo a mano': '…or type the model name',
    'Modo agente': 'Agent mode',
    '(archivos, comandos, git)': '(files, commands, git)',
    '📚 Documentos (RAG)': '📚 Documents (RAG)',
    '(sin contexto documental)': '(no document context)',
    'Servidores locales': 'Local servers',
    'apagado': 'offline',
    'Conversaciones': 'Conversations',
    '📁 Todos': '📁 All',
    '🔍 Buscar en el historial…': '🔍 Search history…',
    'Nueva conversación': 'New conversation',
    'Eliminar conversación': 'Delete conversation',
    '🎁 APIs gratis': '🎁 Free APIs',
    '🧲 Modelos': '🧲 Models',
    '⚙ Ajustes': '⚙ Settings',
    // Composer
    '💬 Chat': '💬 Chat',
    '🖼️ Generar imagen': '🖼️ Generate image',
    '🔊 Generar voz': '🔊 Generate speech',
    '📝 Transcribir audio': '📝 Transcribe audio',
    'Escribe tu mensaje… (Enter para enviar, Shift+Enter para salto de línea)': 'Type your message… (Enter to send, Shift+Enter for newline)',
    'Adjuntar imagen, audio o vídeo': 'Attach image, audio or video',
    'Plantillas de prompts': 'Prompt templates',
    // Barra del chat
    '↻ Regenerar': '↻ Regenerate',
    'Regenerar la última respuesta': 'Regenerate last response',
    'Exportar a Markdown': 'Export to Markdown',
    'Exportar a JSON': 'Export to JSON',
    'Copiar texto': 'Copy text',
    'Copiar': 'Copy',
    'Tokens estimados y coste aproximado de esta conversación': 'Estimated tokens and approximate cost of this conversation',
    'Editar y reenviar desde aquí': 'Edit and resend from here',
    'Bifurcar: nueva conversación con el historial hasta aquí': 'Branch: new conversation with the history up to here',
    'Tú': 'You',
    // Bienvenida
    'Tu frontend local y privado de IA. Selecciona un proveedor y un modelo en la barra lateral.': 'Your local, private AI frontend. Pick a provider and model in the sidebar.',
    // Ajustes
    '⚙ Configuración': '⚙ Settings',
    'Workspace del agente': 'Agent workspace',
    'Carpeta raíz donde el agente trabaja por defecto.': 'Root folder where the agent works by default.',
    'Carpeta de modelos de LM Studio': 'LM Studio models folder',
    'Stable Diffusion local': 'Local Stable Diffusion',
    'ComfyUI local': 'Local ComfyUI',
    'Voz local (opcional)': 'Local voice (optional)',
    'Instrucciones personalizadas': 'Custom instructions',
    'Proveedores de reserva (fallback)': 'Fallback providers',
    'Aprobaciones automáticas del agente': 'Agent auto-approvals',
    'Lectura (listar directorios, leer archivos)': 'Read (list directories, read files)',
    'Escritura (crear/modificar archivos)': 'Write (create/modify files)',
    'Comandos (PowerShell, git, instalaciones)': 'Commands (PowerShell, git, installs)',
    'Red (descargar páginas web con fetch_url)': 'Network (fetch web pages with fetch_url)',
    'Lo que no esté marcado te pedirá aprobación en el chat antes de ejecutarse.': 'Anything unchecked will ask for your approval in the chat before running.',
    'API keys y endpoints': 'API keys & endpoints',
    'Guardar': 'Save',
    'Guardando…': 'Saving…',
    '✓ Guardado': '✓ Saved',
    'Idioma de la interfaz': 'Interface language',
    'Acceso remoto (otros equipos)': 'Remote access (other devices)',
    'Permitir acceso desde la red local': 'Allow access from local network',
    'Usar HTTPS (cifra la contraseña en tránsito)': 'Use HTTPS (encrypts the password in transit)',
    'Entrar': 'Log in',
    'Contraseña': 'Password',
    'Contraseña incorrecta': 'Wrong password',
    'Menú': 'Menu',
    'Abrir menú': 'Open menu',
    'Actualizaciones': 'Updates',
    'Comprobar nueva versión al abrir': 'Check for new version on startup',
    '⬇ Actualizar ahora': '⬇ Update now',
    'Novedades': 'Release notes',
    'Versión actual:': 'Current version:',
    // Modales
    '📁 Proyectos': '📁 Projects',
    'Nuevo proyecto': 'New project',
    'Guardar proyecto': 'Save project',
    '📋 Plantillas de prompts': '📋 Prompt templates',
    'Nueva plantilla': 'New template',
    'Guardar plantilla': 'Save template',
    '📚 Documentos (RAG local)': '📚 Documents (local RAG)',
    'Nueva colección': 'New collection',
    'Indexar carpeta': 'Index folder',
    '🧲 Buscador de modelos (Hugging Face)': '🧲 Model browser (Hugging Face)',
    'Buscar': 'Search',
    '🎁 APIs de IA gratuitas': '🎁 Free AI APIs',
    'Conectores (MCP)': 'Connectors (MCP)',
    // Dinámicos frecuentes
    'ejecutando…': 'running…',
    '⏸ esperando tu aprobación': '⏸ waiting for your approval',
    '✓ completado': '✓ done',
    '✕ rechazado': '✕ rejected',
    '✓ Aprobar': '✓ Approve',
    '✕ Rechazar': '✕ Reject',
    'Ver resultado': 'View result',
    'cargando…': 'loading…',
    '(sin modelos)': '(no models)',
    'usar': 'use',
    'borrar': 'delete',
    'editar': 'edit',
    'modelos': 'models'
  }
};

function dedlitLang() {
  return localStorage.getItem('dedlit.lang') || 'es';
}

function applyI18n() {
  const lang = dedlitLang();
  document.documentElement.lang = lang;
  const dict = I18N[lang];
  if (!dict) return; // español: textos nativos

  const translateNode = node => {
    if (node.nodeType === 3) {
      const t = node.textContent.trim();
      if (t && dict[t]) node.textContent = node.textContent.replace(t, dict[t]);
      return;
    }
    if (node.nodeType !== 1) return;
    for (const attr of ['placeholder', 'title']) {
      const v = node.getAttribute && node.getAttribute(attr);
      if (v && dict[v]) node.setAttribute(attr, dict[v]);
    }
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = walker.nextNode())) {
      const t = n.textContent.trim();
      if (t && dict[t]) n.textContent = n.textContent.replace(t, dict[t]);
    }
    for (const el of node.querySelectorAll('[placeholder],[title]')) {
      for (const attr of ['placeholder', 'title']) {
        const v = el.getAttribute(attr);
        if (v && dict[v]) el.setAttribute(attr, dict[v]);
      }
    }
  };

  translateNode(document.body);
  new MutationObserver(muts => {
    for (const m of muts) {
      if (m.type === 'characterData') translateNode(m.target);
      for (const node of m.addedNodes) translateNode(node);
    }
  }).observe(document.body, { childList: true, subtree: true, characterData: true });
}

function setLanguage(lang) {
  localStorage.setItem('dedlit.lang', lang);
  location.reload(); // recarga para aplicar (o restaurar) los textos
}

document.addEventListener('DOMContentLoaded', applyI18n);
