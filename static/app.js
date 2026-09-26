// KAWAT Mobile Agent Core Script

// Gateway & Backend State
let VERCEL_GATEWAY = localStorage.getItem('kawat_gateway') || 'https://kawatai.vercel.app';
let ACTIVE_BACKEND = localStorage.getItem('kawat_backend_url') || '';
let GEMINI_API_KEY = localStorage.getItem('kawat_gemini_key') || '';
let ACTIVE_MODEL = localStorage.getItem('kawat_model') || 'gemini-2.0-flash';

let ws = null;
let currentAgentTurn = null;
let currentToolCard = null;

// Configure Markdown
marked.setOptions({
  breaks: true,
  gfm: true
});

// DOM Elements
const drawer = document.getElementById('side-drawer');
const drawerOverlay = document.getElementById('drawer-overlay');
const promptInput = document.getElementById('prompt-input');
const btnSend = document.getElementById('btn-send');
const messagesFeed = document.getElementById('messages-feed');
const welcomeHero = document.getElementById('welcome-hero');
const statusDot = document.getElementById('status-dot');
const statusLabel = document.getElementById('status-label');
const activeModelName = document.getElementById('active-model-name');
const drawerBackendTarget = document.getElementById('drawer-backend-target');

// Initialize App
document.addEventListener('DOMContentLoaded', async () => {
  setupEventListeners();
  activeModelName.textContent = ACTIVE_MODEL;
  await resolveBackendFromGateway();
  connectWebSocket();
});

// 1. Resolve Backend URL from Vercel Gateway
async function resolveBackendFromGateway() {
  updateStatusUI('connecting', 'Resolving Gateway...');
  try {
    const res = await fetch(`${VERCEL_GATEWAY.replace(/\/$/, '')}/api/config`, { signal: AbortSignal.timeout(4000) });
    if (res.ok) {
      const data = await res.json();
      ACTIVE_BACKEND = data.backend_url;
      localStorage.setItem('kawat_backend_url', ACTIVE_BACKEND);
      drawerBackendTarget.textContent = ACTIVE_BACKEND;
      updateStatusUI('connecting', 'Connecting Heroku...');
      return;
    }
  } catch (err) {
    console.warn('Gateway lookup failed, using local/cached backend:', err);
  }

  // Fallback to cached or relative host
  if (!ACTIVE_BACKEND) {
    ACTIVE_BACKEND = window.location.origin;
  }
  drawerBackendTarget.textContent = ACTIVE_BACKEND;
}

// 2. Connect WebSocket to Active Backend
function connectWebSocket() {
  if (!ACTIVE_BACKEND) return;

  const wsProto = ACTIVE_BACKEND.startsWith('https') ? 'wss:' : 'ws:';
  const cleanHost = ACTIVE_BACKEND.replace(/^https?:\/\//, '').replace(/\/$/, '');
  const wsUrl = `${wsProto}//${cleanHost}/ws/chat`;

  try {
    if (ws) {
      ws.close();
    }
    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      updateStatusUI('online', 'Heroku Connected');
      loadWorkspaceFileCount();
    };

    ws.onclose = () => {
      updateStatusUI('offline', 'Disconnected');
      setTimeout(connectWebSocket, 4000);
    };

    ws.onerror = () => {
      updateStatusUI('offline', 'Error');
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        handleAgentEvent(data);
      } catch (e) {
        console.error('Failed to parse event:', e);
      }
    };
  } catch (e) {
    console.error('WebSocket connection error:', e);
    updateStatusUI('offline', 'Conn Error');
  }
}

function updateStatusUI(state, text) {
  statusDot.className = `status-indicator-dot ${state}`;
  statusLabel.textContent = text;
}

// 3. Event Handlers
function setupEventListeners() {
  // Drawer Toggles
  document.getElementById('btn-open-drawer').onclick = () => toggleDrawer(true);
  document.getElementById('btn-close-drawer').onclick = () => toggleDrawer(false);
  drawerOverlay.onclick = () => toggleDrawer(false);

  // New Chat
  document.getElementById('btn-new-chat').onclick = startNewSession;

  // Auto-expanding Textarea
  promptInput.addEventListener('input', () => {
    promptInput.style.height = 'auto';
    promptInput.style.height = Math.min(promptInput.scrollHeight, 120) + 'px';
  });

  // Send on Enter (unless shift)
  promptInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendPrompt();
    }
  });

  btnSend.onclick = sendPrompt;

  // Voice Input (Web Speech)
  setupVoiceRecognition();

  // Model Selector Toggle
  document.getElementById('btn-model-select').onclick = cycleModel;

  // Modals
  document.getElementById('btn-open-backend-modal').onclick = openBackendModal;
}

function toggleDrawer(open) {
  drawer.classList.toggle('open', open);
  drawerOverlay.classList.toggle('open', open);
}

function cycleModel() {
  const models = ['gemini-2.0-flash', 'gemini-1.5-pro', 'gemini-1.5-flash'];
  let idx = models.indexOf(ACTIVE_MODEL);
  idx = (idx + 1) % models.length;
  ACTIVE_MODEL = models[idx];
  localStorage.setItem('kawat_model', ACTIVE_MODEL);
  activeModelName.textContent = ACTIVE_MODEL;
}

// 4. Send Message to Agent
function sendPrompt() {
  const text = promptInput.value.trim();
  if (!text) return;

  // Hide hero if first message
  if (welcomeHero) {
    welcomeHero.style.display = 'none';
  }

  // Append user bubble
  appendUserMessage(text);
  promptInput.value = '';
  promptInput.style.height = 'auto';

  // Prepare agent message container
  currentAgentTurn = createAgentTurnContainer();
  currentToolCard = null;

  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      prompt: text,
      api_key: GEMINI_API_KEY,
      model: ACTIVE_MODEL
    }));
  } else {
    appendSystemNotice('WebSocket disconnected. Attempting to reconnect...', 'error');
  }
}

function usePrompt(text) {
  toggleDrawer(false);
  promptInput.value = text;
  promptInput.focus();
  sendPrompt();
}

function appendUserMessage(text) {
  const div = document.createElement('div');
  div.className = 'message-user';
  div.textContent = text;
  messagesFeed.appendChild(div);
  scrollToBottom();
}

function createAgentTurnContainer() {
  const div = document.createElement('div');
  div.className = 'message-agent';
  messagesFeed.appendChild(div);
  scrollToBottom();
  return div;
}

function appendSystemNotice(text, type = 'info') {
  const div = document.createElement('div');
  div.className = `tool-card ${type}`;
  div.innerHTML = `<span style="color:#f59e0b;">⚠️ ${text}</span>`;
  messagesFeed.appendChild(div);
  scrollToBottom();
}

// 5. Handle Live Agent Events
function handleAgentEvent(event) {
  if (!currentAgentTurn) {
    currentAgentTurn = createAgentTurnContainer();
  }

  if (event.type === 'thinking') {
    let thinkBox = currentAgentTurn.querySelector('.thinking-step');
    if (!thinkBox) {
      thinkBox = document.createElement('div');
      thinkBox.className = 'thinking-step';
      thinkBox.style.fontSize = '12px';
      thinkBox.style.color = '#94a3b8';
      thinkBox.style.marginBottom = '6px';
      currentAgentTurn.appendChild(thinkBox);
    }
    thinkBox.innerHTML = `⚡ Step ${event.step}: ${event.status}`;
  } 
  else if (event.type === 'tool_start') {
    const card = document.createElement('div');
    card.className = 'tool-card running';
    
    let toolLabel = event.tool;
    let icon = '⚡';
    if (event.tool === 'write_to_file') {
      icon = '✏️ Writing file';
      toolLabel = event.args.target_file || 'file';
    } else if (event.tool === 'replace_file_content') {
      icon = '✏️ Editing file';
      toolLabel = event.args.target_file || 'file';
    } else if (event.tool === 'view_file') {
      icon = '👁️ Inspecting';
      toolLabel = event.args.target_file || 'file';
    } else if (event.tool === 'run_command') {
      icon = '💻 Terminal';
      toolLabel = event.args.command || 'bash';
    } else if (event.tool === 'push_to_github') {
      icon = '🚀 GitHub Push';
      toolLabel = event.args.repo_name || 'repo';
    }

    card.innerHTML = `
      <div class="tool-header">
        <span class="tool-icon-pulse">${icon}</span>
        <span class="tool-title">${toolLabel}</span>
      </div>
      <div class="tool-body">Executing autonomous action...</div>
    `;
    currentAgentTurn.appendChild(card);
    currentToolCard = card;
  }
  else if (event.type === 'tool_end') {
    if (currentToolCard) {
      currentToolCard.classList.remove('running');
      const body = currentToolCard.querySelector('.tool-body');
      const header = currentToolCard.querySelector('.tool-header');

      const badge = document.createElement('span');
      badge.className = 'tool-badge-done';
      badge.textContent = event.result.success !== false ? '✓ Done' : '✗ Failed';
      header.appendChild(badge);

      let summary = '';
      if (event.result.message) summary = event.result.message;
      else if (event.result.output) summary = event.result.output;
      else if (event.result.repo_url) summary = `Created: <a href="${event.result.repo_url}" target="_blank" style="color:#60a5fa;">${event.result.repo_url}</a>`;
      else if (event.result.error) summary = `Error: ${event.result.error}`;
      else summary = JSON.stringify(event.result);

      body.innerHTML = summary;
    }
    loadWorkspaceFileCount();
  }
  else if (event.type === 'done') {
    const thinkBox = currentAgentTurn.querySelector('.thinking-step');
    if (thinkBox) thinkBox.remove();

    if (event.text) {
      const textDiv = document.createElement('div');
      textDiv.className = 'agent-text-content';
      textDiv.innerHTML = marked.parse(event.text);
      currentAgentTurn.appendChild(textDiv);
      Prism.highlightAllUnder(textDiv);
    }
  }
  else if (event.type === 'error') {
    appendSystemNotice(event.message || 'Unknown agent error', 'error');
  }

  scrollToBottom();
}

function scrollToBottom() {
  const container = document.getElementById('chat-container');
  container.scrollTop = container.scrollHeight;
}

function startNewSession() {
  toggleDrawer(false);
  messagesFeed.innerHTML = '';
  if (welcomeHero) welcomeHero.style.display = 'flex';
}

// 6. Voice Recognition
function setupVoiceRecognition() {
  const micBtn = document.getElementById('btn-mic');
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

  if (SpeechRecognition) {
    const recognition = new SpeechRecognition();
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.lang = 'hi-IN'; // Supports Hindi + Hinglish + English

    micBtn.onclick = () => {
      micBtn.style.color = '#ef4444';
      recognition.start();
    };

    recognition.onresult = (event) => {
      const transcript = event.results[0][0].transcript;
      promptInput.value = (promptInput.value + ' ' + transcript).trim();
      micBtn.style.color = '';
    };

    recognition.onerror = () => { micBtn.style.color = ''; };
    recognition.onend = () => { micBtn.style.color = ''; };
  } else {
    micBtn.style.display = 'none';
  }
}

// 7. Modals & Settings
function openBackendModal() {
  document.getElementById('gateway-input').value = VERCEL_GATEWAY;
  document.getElementById('backend-input').value = ACTIVE_BACKEND;
  document.getElementById('api-key-input').value = GEMINI_API_KEY;
  document.getElementById('modal-backend').classList.add('open');
}

function closeModal(id) {
  document.getElementById(id).classList.remove('open');
}

async function saveSettings() {
  VERCEL_GATEWAY = document.getElementById('gateway-input').value.trim();
  const directBackend = document.getElementById('backend-input').value.trim();
  GEMINI_API_KEY = document.getElementById('api-key-input').value.trim();

  localStorage.setItem('kawat_gateway', VERCEL_GATEWAY);
  if (directBackend) {
    ACTIVE_BACKEND = directBackend;
    localStorage.setItem('kawat_backend_url', ACTIVE_BACKEND);
  }
  localStorage.setItem('kawat_gemini_key', GEMINI_API_KEY);

  closeModal('modal-backend');
  connectWebSocket();
}

async function checkConnection() {
  const resBox = document.getElementById('conn-result');
  resBox.textContent = 'Pinging...';
  resBox.style.color = '#f59e0b';

  try {
    const res = await fetch(`${ACTIVE_BACKEND.replace(/\/$/, '')}/api/status`);
    if (res.ok) {
      const data = await res.json();
      resBox.textContent = `✓ Online! Found ${data.workspace_files} files in workspace.`;
      resBox.style.color = '#10b981';
    } else {
      resBox.textContent = '✗ Server returned error code ' + res.status;
      resBox.style.color = '#ef4444';
    }
  } catch (err) {
    resBox.textContent = '✗ Connection failed: ' + err.message;
    resBox.style.color = '#ef4444';
  }
}

// 8. Workspace Explorer
async function openWorkspaceTab() {
  toggleDrawer(false);
  const modal = document.getElementById('modal-workspace');
  modal.classList.add('open');
  const treeBox = document.getElementById('workspace-file-tree');
  treeBox.textContent = 'Loading workspace files...';

  try {
    const res = await fetch(`${ACTIVE_BACKEND.replace(/\/$/, '')}/api/files`);
    const data = await res.json();
    treeBox.innerHTML = '';

    if (!data.files || data.files.length === 0) {
      treeBox.innerHTML = '<div style="color:#94a3b8; padding:8px;">Workspace is empty. Ask the agent to build something!</div>';
      return;
    }

    data.files.forEach(item => {
      const el = document.createElement('div');
      el.className = 'file-tree-item';
      el.innerHTML = `<span>${item.is_dir ? '📁' : '📄'}</span> <span>${item.path}</span>`;
      if (!item.is_dir) {
        el.onclick = () => previewFile(item.path);
      }
      treeBox.appendChild(el);
    });
  } catch (e) {
    treeBox.textContent = 'Failed to load files: ' + e.message;
  }
}

async function previewFile(path) {
  try {
    const res = await fetch(`${ACTIVE_BACKEND.replace(/\/$/, '')}/api/files/content?path=${encodeURIComponent(path)}`);
    const data = await res.json();
    document.getElementById('preview-filename').textContent = path;
    const codeEl = document.getElementById('preview-code');
    codeEl.textContent = data.content;
    document.getElementById('file-preview-box').style.display = 'block';
    Prism.highlightElement(codeEl);
  } catch (e) {
    alert('Error loading file: ' + e.message);
  }
}

function closeFilePreview() {
  document.getElementById('file-preview-box').style.display = 'none';
}

async function loadWorkspaceFileCount() {
  try {
    const res = await fetch(`${ACTIVE_BACKEND.replace(/\/$/, '')}/api/status`);
    if (res.ok) {
      const data = await res.json();
      document.getElementById('drawer-file-count').textContent = data.workspace_files || 0;
    }
  } catch (e) {}
}

function downloadZip() {
  if (!ACTIVE_BACKEND) return;
  window.open(`${ACTIVE_BACKEND.replace(/\/$/, '')}/api/download-zip`, '_blank');
}
