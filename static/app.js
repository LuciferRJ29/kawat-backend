// KAWAT Mobile Agent Core Script — Hybrid Real Autonomous Engine

// State & Config
let VERCEL_GATEWAY = localStorage.getItem('kawat_gateway') || 'https://kawatai.vercel.app';
let ACTIVE_BACKEND = localStorage.getItem('kawat_backend_url') || '';
let ACTIVE_MODEL = localStorage.getItem('kawat_model') || 'gemini-3.8-flash';

function getModelDisplayName(model) {
  if (!model) return 'Kawat 1';
  if (model.includes('3.8') || model.includes('kawat-1')) return 'Kawat 1';
  if (model.includes('2.0')) return 'Kawat 1 Lite';
  if (model.includes('1.5-pro')) return 'Kawat Pro';
  return 'Kawat 1';
}

// Virtual Workspace (Files saved locally on phone)
let workspaceFiles = {};
try {
  workspaceFiles = JSON.parse(localStorage.getItem('kawat_workspace_files') || '{}');
} catch (e) {
  workspaceFiles = {};
}

let ws = null;
let currentAgentTurn = null;
let currentToolCard = null;
let isHerokuConnected = false;

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
const headerStatusDot = document.getElementById('header-status-dot');
const activeModelName = document.getElementById('active-model-name');
const drawerEngineTitle = document.getElementById('drawer-engine-title');
const drawerBackendTarget = document.getElementById('drawer-backend-target');
const drawerFileCount = document.getElementById('drawer-file-count');
const setupAlertBanner = document.getElementById('setup-alert-banner');

// ==========================================
// 1. Android Hardware Back Button Handler
// ==========================================
window.handleAndroidBack = function() {
  // If drawer is open, close it
  if (drawer && drawer.classList.contains('open')) {
    toggleDrawer(false);
    return true;
  }

  // If any modal is open, close it
  const openModal = document.querySelector('.modal-backdrop.open');
  if (openModal) {
    // If file preview inside modal is open, close preview first
    const filePreview = document.getElementById('file-preview-box');
    if (filePreview && filePreview.style.display === 'block') {
      closeFilePreview();
      return true;
    }
    openModal.classList.remove('open');
    return true;
  }

  // Not handled -> allows native double-tap back to exit
  return false;
};

// ==========================================
// 2. Initialize App
// ==========================================
document.addEventListener('DOMContentLoaded', async () => {
  setupEventListeners();
  updateUIFromState();
  updateFileCounts();

  // Try connecting to Heroku / Vercel if configured
  if (ACTIVE_BACKEND || VERCEL_GATEWAY) {
    await resolveBackendAndConnect();
  } else {
    evaluateEngineStatus();
  }
});

function updateUIFromState() {
  activeModelName.textContent = getModelDisplayName(ACTIVE_MODEL);
  document.getElementById('model-select-dropdown').value = ACTIVE_MODEL;
  document.getElementById('api-key-input').value = GEMINI_API_KEY;
  document.getElementById('backend-input').value = ACTIVE_BACKEND;
  document.getElementById('gateway-input').value = VERCEL_GATEWAY;
}

function evaluateEngineStatus() {
  if (isHerokuConnected) {
    headerStatusDot.className = 'status-indicator-dot';
    headerStatusDot.title = 'Heroku Connected';
    drawerEngineTitle.textContent = '⚡ Heroku Backend Live';
    drawerBackendTarget.textContent = ACTIVE_BACKEND;
    if (setupAlertBanner) setupAlertBanner.style.display = 'none';
  } else if (GEMINI_API_KEY) {
    headerStatusDot.className = 'status-indicator-dot direct';
    headerStatusDot.title = 'Direct AI Active';
    drawerEngineTitle.textContent = '⚡ Direct Gemini Client AI';
    drawerBackendTarget.textContent = 'Autonomous Phone Engine (Ready)';
    if (setupAlertBanner) setupAlertBanner.style.display = 'none';
  } else {
    headerStatusDot.className = 'status-indicator-dot checking';
    headerStatusDot.title = 'Setup Required';
    drawerEngineTitle.textContent = '⚠️ Setup Required';
    drawerBackendTarget.textContent = 'Enter Gemini Key or Heroku URL';
    if (setupAlertBanner) setupAlertBanner.style.display = 'flex';
  }
}

// ==========================================
// 3. Backend Resolution & WebSocket
// ==========================================
async function resolveBackendAndConnect() {
  if (VERCEL_GATEWAY) {
    try {
      const res = await fetch(`${VERCEL_GATEWAY.replace(/\/$/, '')}/api/config`, { signal: AbortSignal.timeout(3000) });
      if (res.ok) {
        const data = await res.json();
        if (data.backend_url) {
          ACTIVE_BACKEND = data.backend_url;
          localStorage.setItem('kawat_backend_url', ACTIVE_BACKEND);
        }
      }
    } catch (e) {
      console.log('Gateway check bypassed');
    }
  }

  if (ACTIVE_BACKEND) {
    connectWebSocket();
  } else {
    evaluateEngineStatus();
  }
}

function connectWebSocket() {
  if (!ACTIVE_BACKEND) return;

  const wsProto = ACTIVE_BACKEND.startsWith('https') ? 'wss:' : 'ws:';
  const cleanHost = ACTIVE_BACKEND.replace(/^https?:\/\//, '').replace(/\/$/, '');
  const wsUrl = `${wsProto}//${cleanHost}/ws/chat`;

  try {
    if (ws) ws.close();
    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      isHerokuConnected = true;
      evaluateEngineStatus();
      syncRemoteFiles();
    };

    ws.onclose = () => {
      isHerokuConnected = false;
      evaluateEngineStatus();
    };

    ws.onerror = () => {
      isHerokuConnected = false;
      evaluateEngineStatus();
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
    isHerokuConnected = false;
    evaluateEngineStatus();
  }
}

// ==========================================
// 4. Send Message / Execute Agent Task
// ==========================================
async function sendPrompt() {
  const text = promptInput.value.trim();
  if (!text) return;

  // Check if agent is configured
  if (!isHerokuConnected && !GEMINI_API_KEY) {
    openBackendModal();
    return;
  }

  // Hide welcome hero
  if (welcomeHero) welcomeHero.style.display = 'none';

  appendUserMessage(text);
  promptInput.value = '';
  promptInput.style.height = 'auto';

  currentAgentTurn = createAgentTurnContainer();
  currentToolCard = null;

  // Mode A: If Heroku WebSocket is live, use Heroku
  if (isHerokuConnected && ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      prompt: text,
      api_key: GEMINI_API_KEY,
      model: ACTIVE_MODEL
    }));
  } else {
    // Mode B: Direct Client Autonomous Agent Loop!
    await executeClientAgentTurn(text);
  }
}

// ==========================================
// 5. Direct Client Autonomous Agent Engine
// ==========================================
const CLIENT_TOOLS = [
  {
    name: "write_to_file",
    description: "Create or overwrite a file with complete source code inside the project workspace.",
    parameters: {
      type: "OBJECT",
      properties: {
        target_file: { type: "STRING", description: "Relative file path (e.g. 'main.py' or 'bot.py')." },
        content: { type: "STRING", description: "Complete source code." }
      },
      required: ["target_file", "content"]
    }
  },
  {
    name: "replace_file_content",
    description: "Modify an existing file by replacing a specific block of text.",
    parameters: {
      type: "OBJECT",
      properties: {
        target_file: { type: "STRING", description: "Path of file to edit." },
        target_content: { type: "STRING", description: "Existing text to replace." },
        replacement_content: { type: "STRING", description: "New replacement text." }
      },
      required: ["target_file", "target_content", "replacement_content"]
    }
  },
  {
    name: "view_file",
    description: "Read file contents to inspect existing code before editing.",
    parameters: {
      type: "OBJECT",
      properties: {
        target_file: { type: "STRING", description: "File path to view." }
      },
      required: ["target_file"]
    }
  },
  {
    name: "list_dir",
    description: "List all files in the project workspace.",
    parameters: {
      type: "OBJECT",
      properties: {}
    }
  },
  {
    name: "push_to_github",
    description: "Create a GitHub repository and push all workspace files using the user's GitHub Personal Access Token.",
    parameters: {
      type: "OBJECT",
      properties: {
        repo_name: { type: "STRING", description: "Name for GitHub repo." },
        github_token: { type: "STRING", description: "User's GitHub token (ghp_...)." }
      },
      required: ["repo_name", "github_token"]
    }
  }
];

async function executeClientAgentTurn(userPrompt) {
  const systemInstruction = `You are KAWAT AI — a 100% autonomous mobile coding agent.
You take real action:
1. When asked to build a bot or write code, write the complete files using write_to_file. Do not just chat.
2. When asked to edit or modify a file, inspect it with view_file or edit with replace_file_content.
3. When asked to push to GitHub, call push_to_github.
4. Speak in friendly, concise Hinglish / Hindi.`;

  let history = [
    {
      role: "user",
      parts: [{ text: userPrompt }]
    }
  ];

  let step = 0;
  const maxSteps = 15;

  while (step < maxSteps) {
    step++;
    handleAgentEvent({ type: 'thinking', step: step, status: 'Analyzing code structure & planning actions...' });

    let targetModel = ACTIVE_MODEL;
    let apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${targetModel}:generateContent?key=${GEMINI_API_KEY}`;
    const payload = {
      systemInstruction: { parts: [{ text: systemInstruction }] },
      contents: history,
      tools: [{ functionDeclarations: CLIENT_TOOLS }]
    };

    let data;
    try {
      let response = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      // Fallback if 3.8 is not available on standard public API endpoint
      if (response.status === 404 && targetModel.includes('3.8')) {
        targetModel = 'gemini-2.0-flash';
        apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${targetModel}:generateContent?key=${GEMINI_API_KEY}`;
        response = await fetch(apiUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
      }
      data = await response.json();
    } catch (err) {
      handleAgentEvent({ type: 'error', message: 'Failed to contact Gemini API: ' + err.message });
      break;
    }

    if (data.error) {
      handleAgentEvent({ type: 'error', message: data.error.message || 'Gemini API Error' });
      break;
    }

    const candidate = data.candidates && data.candidates[0];
    if (!candidate) {
      handleAgentEvent({ type: 'done', text: 'No response generated.' });
      break;
    }

    const content = candidate.content;
    history.push(content);

    // Check for function calls
    const functionCalls = [];
    let textResponse = '';

    for (const part of (content.parts || [])) {
      if (part.functionCall) {
        functionCalls.push(part.functionCall);
      }
      if (part.text) {
        textResponse += part.text;
      }
    }

    if (functionCalls.length === 0) {
      handleAgentEvent({ type: 'done', text: textResponse });
      break;
    }

    // Execute functions client-side
    const responseParts = [];
    for (const fc of functionCalls) {
      const fnName = fc.name;
      const fnArgs = fc.args || {};

      handleAgentEvent({ type: 'tool_start', tool: fnName, args: fnArgs });
      const result = await executeLocalTool(fnName, fnArgs);
      handleAgentEvent({ type: 'tool_end', tool: fnName, result: result });

      responseParts.push({
        functionResponse: {
          name: fnName,
          response: { result: result }
        }
      });
    }

    history.push({
      role: "tool",
      parts: responseParts
    });
  }
}

// Local Tool Implementations
async function executeLocalTool(name, args) {
  if (name === 'write_to_file') {
    const path = args.target_file;
    const content = args.content || '';
    workspaceFiles[path] = content;
    saveWorkspace();
    updateFileCounts();
    return { success: true, message: `Successfully created '${path}' (${content.length} bytes).` };
  }
  else if (name === 'replace_file_content') {
    const path = args.target_file;
    if (!workspaceFiles[path]) return { success: false, error: `File '${path}' not found.` };
    const oldText = workspaceFiles[path];
    if (!oldText.includes(args.target_content)) {
      return { success: false, error: `Target text not found in '${path}'.` };
    }
    workspaceFiles[path] = oldText.replace(args.target_content, args.replacement_content);
    saveWorkspace();
    return { success: true, message: `Successfully edited '${path}'.` };
  }
  else if (name === 'view_file') {
    const path = args.target_file;
    if (!workspaceFiles[path]) return { success: false, error: `File '${path}' not found.` };
    const lines = workspaceFiles[path].split('\n').map((l, i) => `${i + 1}: ${l}`).join('\n');
    return { success: true, content: lines };
  }
  else if (name === 'list_dir') {
    const files = Object.keys(workspaceFiles).map(f => ({ name: f, size: workspaceFiles[f].length }));
    return { success: true, files: files };
  }
  else if (name === 'push_to_github') {
    return await executeClientGithubPush(args.repo_name, args.github_token);
  }
  return { success: false, error: 'Unknown tool ' + name };
}

// Client-side GitHub Pusher (Direct from Phone!)
async function executeClientGithubPush(repoName, token) {
  if (!token) return { success: false, error: 'GitHub Token is required.' };
  try {
    const cleanToken = token.trim();
    // 1. Get user
    const userRes = await fetch('https://api.github.com/user', {
      headers: { 'Authorization': `token ${cleanToken}`, 'Accept': 'application/vnd.github.v3+json' }
    });
    if (!userRes.ok) return { success: false, error: 'Invalid GitHub Token.' };
    const userData = await userRes.json();
    const username = userData.login;

    // 2. Create repo
    await fetch('https://api.github.com/user/repos', {
      method: 'POST',
      headers: { 'Authorization': `token ${cleanToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: repoName, description: 'Created autonomously by KAWAT Agent', private: false })
    });

    // 3. Push files
    let pushed = 0;
    for (const [path, content] of Object.entries(workspaceFiles)) {
      const b64 = btoa(unescape(encodeURIComponent(content)));
      await fetch(`https://api.github.com/repos/${username}/${repoName}/contents/${path}`, {
        method: 'PUT',
        headers: { 'Authorization': `token ${cleanToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: `Add ${path} via KAWAT Agent`, content: b64 })
      });
      pushed++;
    }

    const repoUrl = `https://github.com/${username}/${repoName}`;
    return { success: true, repo_url: repoUrl, pushed_files: pushed };
  } catch (err) {
    return { success: false, error: 'Push error: ' + err.message };
  }
}

// Workspace Persistence
function saveWorkspace() {
  localStorage.setItem('kawat_workspace_files', JSON.stringify(workspaceFiles));
}

function updateFileCounts() {
  const count = Object.keys(workspaceFiles).length;
  if (drawerFileCount) drawerFileCount.textContent = count;
  const modalCount = document.getElementById('modal-file-count');
  if (modalCount) modalCount.textContent = count;
}

// ==========================================
// 6. Live Agent Event Rendering
// ==========================================
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

    let icon = '⚡';
    let toolLabel = event.tool;
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
      else if (event.result.repo_url) summary = `Created: <a href="${event.result.repo_url}" target="_blank" style="color:#60a5fa; font-weight:600;">${event.result.repo_url}</a>`;
      else if (event.result.error) summary = `Error: ${event.result.error}`;
      else summary = JSON.stringify(event.result);

      body.innerHTML = summary;
    }
    updateFileCounts();
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
    appendSystemNotice(event.message || 'Error occurred', 'error');
  }

  scrollToBottom();
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

function scrollToBottom() {
  const container = document.getElementById('chat-container');
  container.scrollTop = container.scrollHeight;
}

function usePrompt(text) {
  toggleDrawer(false);
  promptInput.value = text;
  promptInput.focus();
  sendPrompt();
}

function startNewSession() {
  toggleDrawer(false);
  messagesFeed.innerHTML = '';
  if (welcomeHero) welcomeHero.style.display = 'flex';
}

// ==========================================
// 7. Event Listeners & Modals
// ==========================================
function setupEventListeners() {
  document.getElementById('btn-open-drawer').onclick = () => toggleDrawer(true);
  document.getElementById('btn-close-drawer').onclick = () => toggleDrawer(false);
  drawerOverlay.onclick = () => toggleDrawer(false);

  document.getElementById('btn-new-chat').onclick = startNewSession;

  promptInput.addEventListener('input', () => {
    promptInput.style.height = 'auto';
    promptInput.style.height = Math.min(promptInput.scrollHeight, 120) + 'px';
  });

  promptInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendPrompt();
    }
  });

  btnSend.onclick = sendPrompt;

  document.getElementById('btn-model-select').onclick = openBackendModal;

  setupVoiceRecognition();
}

function toggleDrawer(open) {
  drawer.classList.toggle('open', open);
  drawerOverlay.classList.toggle('open', open);
}

function openBackendModal() {
  toggleDrawer(false);
  document.getElementById('api-key-input').value = GEMINI_API_KEY;
  document.getElementById('backend-input').value = ACTIVE_BACKEND;
  document.getElementById('gateway-input').value = VERCEL_GATEWAY;
  document.getElementById('model-select-dropdown').value = ACTIVE_MODEL;
  document.getElementById('modal-backend').classList.add('open');
}

function closeModal(id) {
  document.getElementById(id).classList.remove('open');
}

async function saveSettings() {
  GEMINI_API_KEY = document.getElementById('api-key-input').value.trim();
  ACTIVE_BACKEND = document.getElementById('backend-input').value.trim();
  VERCEL_GATEWAY = document.getElementById('gateway-input').value.trim();
  ACTIVE_MODEL = document.getElementById('model-select-dropdown').value;

  localStorage.setItem('kawat_gemini_key', GEMINI_API_KEY);
  localStorage.setItem('kawat_backend_url', ACTIVE_BACKEND);
  localStorage.setItem('kawat_gateway', VERCEL_GATEWAY);
  localStorage.setItem('kawat_model', ACTIVE_MODEL);

  activeModelName.textContent = getModelDisplayName(ACTIVE_MODEL);
  closeModal('modal-backend');

  evaluateEngineStatus();
  if (ACTIVE_BACKEND) {
    connectWebSocket();
  }
}

async function checkConnection() {
  const resBox = document.getElementById('conn-result');
  const testBackend = document.getElementById('backend-input').value.trim();
  const testKey = document.getElementById('api-key-input').value.trim();

  resBox.textContent = 'Testing connection...';
  resBox.style.color = '#f59e0b';

  let messages = [];

  // Test Gemini Key
  if (testKey) {
    try {
      const gemRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${testKey}`);
      if (gemRes.ok) messages.push('✓ Gemini API Key Valid!');
      else messages.push('✗ Invalid Gemini API Key');
    } catch (e) {
      messages.push('✗ Gemini Key check error');
    }
  }

  // Test Heroku Backend
  if (testBackend) {
    try {
      const res = await fetch(`${testBackend.replace(/\/$/, '')}/api/status`);
      if (res.ok) messages.push('✓ Heroku Backend Online!');
      else messages.push(`✗ Heroku returned ${res.status}`);
    } catch (e) {
      messages.push('✗ Heroku Unreachable');
    }
  }

  if (messages.length === 0) {
    resBox.textContent = 'Please enter a Gemini API Key or Heroku URL first.';
    resBox.style.color = '#f59e0b';
  } else {
    resBox.innerHTML = messages.join('<br>');
    resBox.style.color = messages.some(m => m.includes('✓')) ? '#10b981' : '#ef4444';
  }
}

// ==========================================
// 8. Workspace Explorer & ZIP Download
// ==========================================
function openWorkspaceTab() {
  toggleDrawer(false);
  const modal = document.getElementById('modal-workspace');
  modal.classList.add('open');
  const treeBox = document.getElementById('workspace-file-tree');
  treeBox.innerHTML = '';

  const fileNames = Object.keys(workspaceFiles);
  if (fileNames.length === 0) {
    treeBox.innerHTML = '<div style="color:#94a3b8; padding:8px;">Workspace is empty. Ask Kawat to build a bot!</div>';
    return;
  }

  fileNames.sort().forEach(path => {
    const el = document.createElement('div');
    el.className = 'file-tree-item';
    el.innerHTML = `<span>📄</span> <span>${path}</span> <span style="margin-left:auto; font-size:11px; color:#64748b;">${workspaceFiles[path].length}B</span>`;
    el.onclick = () => previewFile(path);
    treeBox.appendChild(el);
  });
}

function previewFile(path) {
  const content = workspaceFiles[path];
  if (content === undefined) return;
  document.getElementById('preview-filename').textContent = path;
  const codeEl = document.getElementById('preview-code');
  codeEl.textContent = content;
  document.getElementById('file-preview-box').style.display = 'block';
  Prism.highlightElement(codeEl);
}

function closeFilePreview() {
  document.getElementById('file-preview-box').style.display = 'none';
}

function clearWorkspaceFiles() {
  if (confirm('Clear all workspace files?')) {
    workspaceFiles = {};
    saveWorkspace();
    updateFileCounts();
    openWorkspaceTab();
  }
}

// Download ZIP (Works 100% Offline / Client-side with JSZip!)
async function downloadZip() {
  const fileNames = Object.keys(workspaceFiles);
  if (fileNames.length === 0) {
    alert('No files in workspace to download!');
    return;
  }

  try {
    const zip = new JSZip();
    for (const [path, content] of Object.entries(workspaceFiles)) {
      zip.file(path, content);
    }
    const blob = await zip.generateAsync({ type: 'blob' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'kawat_project.zip';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  } catch (err) {
    alert('Failed to generate ZIP: ' + err.message);
  }
}

// ==========================================
// 9. Voice Input
// ==========================================
function setupVoiceRecognition() {
  const micBtn = document.getElementById('btn-mic');
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

  if (SpeechRecognition) {
    const recognition = new SpeechRecognition();
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.lang = 'hi-IN';

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
