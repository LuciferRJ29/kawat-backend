// KAWAT Mobile Agent Core Script — Hybrid Real Autonomous Engine
// Fully Guarded & Zero-Failure Architecture

// Global State & Config
let VERCEL_GATEWAY = localStorage.getItem('kawat_gateway') || 'https://kawatai.vercel.app';
let ACTIVE_BACKEND = localStorage.getItem('kawat_backend_url') || '';
let GEMINI_API_KEY = localStorage.getItem('kawat_gemini_key') || '';
let ACTIVE_MODEL = localStorage.getItem('kawat_model') || 'gemini-3.8-flash';

function getModelDisplayName(model) {
  if (!model) return 'Kawat 1';
  if (model.includes('3.8') || model.includes('kawat-1')) return 'Kawat 1';
  if (model.includes('2.0')) return 'Kawat 1 Lite';
  if (model.includes('1.5-pro')) return 'Kawat Pro';
  return 'Kawat 1';
}

// Virtual Workspace (Persistent on Phone)
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
let speechRecognizer = null;

// Markdown Support
if (typeof marked !== 'undefined') {
  marked.setOptions({ breaks: true, gfm: true });
}

// ==========================================
// 1. Android Hardware Back Button Handler
// ==========================================
window.handleAndroidBack = function() {
  const drawer = document.getElementById('side-drawer');
  if (drawer && drawer.classList.contains('open')) {
    toggleDrawer(false);
    return true;
  }

  const openModal = document.querySelector('.modal-backdrop.open');
  if (openModal) {
    const filePreview = document.getElementById('file-preview-box');
    if (filePreview && filePreview.style.display === 'block') {
      closeFilePreview();
      return true;
    }
    openModal.classList.remove('open');
    return true;
  }

  return false;
};

// ==========================================
// 2. Global Actions (Exposed to window)
// ==========================================
function toggleDrawer(open) {
  const drawer = document.getElementById('side-drawer');
  const drawerOverlay = document.getElementById('drawer-overlay');
  if (drawer) drawer.classList.toggle('open', open);
  if (drawerOverlay) drawerOverlay.classList.toggle('open', open);
}

function openBackendModal() {
  toggleDrawer(false);
  const apiKeyInp = document.getElementById('api-key-input');
  const backendInp = document.getElementById('backend-input');
  const gatewayInp = document.getElementById('gateway-input');
  const modelDropdown = document.getElementById('model-select-dropdown');
  const modal = document.getElementById('modal-backend');

  if (apiKeyInp) apiKeyInp.value = GEMINI_API_KEY;
  if (backendInp) backendInp.value = ACTIVE_BACKEND;
  if (gatewayInp) gatewayInp.value = VERCEL_GATEWAY;
  if (modelDropdown) modelDropdown.value = ACTIVE_MODEL;
  if (modal) modal.classList.add('open');
}

function closeModal(id) {
  const modal = document.getElementById(id);
  if (modal) modal.classList.remove('open');
}

function startNewSession() {
  toggleDrawer(false);
  const messagesFeed = document.getElementById('messages-feed');
  const welcomeHero = document.getElementById('welcome-hero');
  if (messagesFeed) messagesFeed.innerHTML = '';
  if (welcomeHero) welcomeHero.style.display = 'flex';
}

function usePrompt(text) {
  toggleDrawer(false);
  const promptInput = document.getElementById('prompt-input');
  if (promptInput) {
    promptInput.value = text;
    promptInput.focus();
  }
  sendPrompt();
}

async function saveSettings() {
  const apiKeyInp = document.getElementById('api-key-input');
  const backendInp = document.getElementById('backend-input');
  const gatewayInp = document.getElementById('gateway-input');
  const modelDropdown = document.getElementById('model-select-dropdown');
  const activeModelName = document.getElementById('active-model-name');

  if (apiKeyInp) GEMINI_API_KEY = apiKeyInp.value.trim();
  if (backendInp) ACTIVE_BACKEND = backendInp.value.trim();
  if (gatewayInp) VERCEL_GATEWAY = gatewayInp.value.trim();
  if (modelDropdown) ACTIVE_MODEL = modelDropdown.value;

  localStorage.setItem('kawat_gemini_key', GEMINI_API_KEY);
  localStorage.setItem('kawat_backend_url', ACTIVE_BACKEND);
  localStorage.setItem('kawat_gateway', VERCEL_GATEWAY);
  localStorage.setItem('kawat_model', ACTIVE_MODEL);

  if (activeModelName) activeModelName.textContent = getModelDisplayName(ACTIVE_MODEL);
  closeModal('modal-backend');

  evaluateEngineStatus();
  if (ACTIVE_BACKEND) {
    connectWebSocket();
  }
}

async function checkConnection() {
  const resBox = document.getElementById('conn-result');
  const testBackend = document.getElementById('backend-input') ? document.getElementById('backend-input').value.trim() : '';
  const testKey = document.getElementById('api-key-input') ? document.getElementById('api-key-input').value.trim() : '';

  if (!resBox) return;
  resBox.textContent = 'Testing connection...';
  resBox.style.color = '#f59e0b';

  let messages = [];

  if (testKey) {
    try {
      const gemRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${testKey}`);
      if (gemRes.ok) messages.push('✓ Gemini API Key Valid!');
      else messages.push('✗ Invalid Gemini API Key');
    } catch (e) {
      messages.push('✗ Gemini Key check error');
    }
  }

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

// Workspace Modal
function openWorkspaceTab() {
  toggleDrawer(false);
  const modal = document.getElementById('modal-workspace');
  if (modal) modal.classList.add('open');
  const treeBox = document.getElementById('workspace-file-tree');
  if (!treeBox) return;
  treeBox.innerHTML = '';

  const fileNames = Object.keys(workspaceFiles);
  if (fileNames.length === 0) {
    treeBox.innerHTML = '<div style="color:#94a3b8; padding:8px;">Workspace is empty. Ask Kawat to build something!</div>';
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
  const filenameEl = document.getElementById('preview-filename');
  const codeEl = document.getElementById('preview-code');
  const previewBox = document.getElementById('file-preview-box');

  if (filenameEl) filenameEl.textContent = path;
  if (codeEl) {
    codeEl.textContent = content;
    if (typeof Prism !== 'undefined') Prism.highlightElement(codeEl);
  }
  if (previewBox) previewBox.style.display = 'block';
}

function closeFilePreview() {
  const previewBox = document.getElementById('file-preview-box');
  if (previewBox) previewBox.style.display = 'none';
}

function clearWorkspaceFiles() {
  if (confirm('Clear all workspace files?')) {
    workspaceFiles = {};
    saveWorkspace();
    updateFileCounts();
    openWorkspaceTab();
  }
}

async function downloadZip() {
  const fileNames = Object.keys(workspaceFiles);
  if (fileNames.length === 0) {
    alert('No files in workspace to download!');
    return;
  }

  if (typeof JSZip === 'undefined') {
    alert('ZIP utility loading, please try again in a second.');
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

function triggerVoice() {
  const micBtn = document.getElementById('btn-mic');
  const promptInput = document.getElementById('prompt-input');
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

  if (SpeechRecognition) {
    if (!speechRecognizer) {
      speechRecognizer = new SpeechRecognition();
      speechRecognizer.continuous = false;
      speechRecognizer.interimResults = false;
      speechRecognizer.lang = 'hi-IN';

      speechRecognizer.onresult = (event) => {
        const transcript = event.results[0][0].transcript;
        if (promptInput) {
          promptInput.value = (promptInput.value + ' ' + transcript).trim();
        }
        if (micBtn) micBtn.style.color = '';
      };
      speechRecognizer.onerror = () => { if (micBtn) micBtn.style.color = ''; };
      speechRecognizer.onend = () => { if (micBtn) micBtn.style.color = ''; };
    }
    if (micBtn) micBtn.style.color = '#ef4444';
    speechRecognizer.start();
  } else {
    alert('Voice recognition not supported on this browser/device.');
  }
}

// ATTACH TO WINDOW EXPLICITLY (Zero missing function errors!)
window.toggleDrawer = toggleDrawer;
window.openBackendModal = openBackendModal;
window.closeModal = closeModal;
window.startNewSession = startNewSession;
window.usePrompt = usePrompt;
window.saveSettings = saveSettings;
window.checkConnection = checkConnection;
window.openWorkspaceTab = openWorkspaceTab;
window.closeFilePreview = closeFilePreview;
window.clearWorkspaceFiles = clearWorkspaceFiles;
window.downloadZip = downloadZip;
window.triggerVoice = triggerVoice;

// ==========================================
// 3. UI State & Engine Evaluation
// ==========================================
function updateUIFromState() {
  const activeModelName = document.getElementById('active-model-name');
  const modelDropdown = document.getElementById('model-select-dropdown');
  const apiKeyInp = document.getElementById('api-key-input');
  const backendInp = document.getElementById('backend-input');
  const gatewayInp = document.getElementById('gateway-input');

  if (activeModelName) activeModelName.textContent = getModelDisplayName(ACTIVE_MODEL);
  if (modelDropdown) modelDropdown.value = ACTIVE_MODEL;
  if (apiKeyInp) apiKeyInp.value = GEMINI_API_KEY;
  if (backendInp) backendInp.value = ACTIVE_BACKEND;
  if (gatewayInp) gatewayInp.value = VERCEL_GATEWAY;
}

function evaluateEngineStatus() {
  const headerStatusDot = document.getElementById('header-status-dot');
  const drawerEngineTitle = document.getElementById('drawer-engine-title');
  const drawerBackendTarget = document.getElementById('drawer-backend-target');
  const setupAlertBanner = document.getElementById('setup-alert-banner');

  if (isHerokuConnected) {
    if (headerStatusDot) { headerStatusDot.className = 'status-indicator-dot'; headerStatusDot.title = 'Heroku Connected'; }
    if (drawerEngineTitle) drawerEngineTitle.textContent = '⚡ Heroku Backend Live';
    if (drawerBackendTarget) drawerBackendTarget.textContent = ACTIVE_BACKEND;
    if (setupAlertBanner) setupAlertBanner.style.display = 'none';
  } else if (GEMINI_API_KEY) {
    if (headerStatusDot) { headerStatusDot.className = 'status-indicator-dot direct'; headerStatusDot.title = 'Direct AI Active'; }
    if (drawerEngineTitle) drawerEngineTitle.textContent = '⚡ Direct Gemini Client AI';
    if (drawerBackendTarget) drawerBackendTarget.textContent = 'Autonomous Phone Engine (Ready)';
    if (setupAlertBanner) setupAlertBanner.style.display = 'none';
  } else {
    if (headerStatusDot) { headerStatusDot.className = 'status-indicator-dot checking'; headerStatusDot.title = 'Setup Required'; }
    if (drawerEngineTitle) drawerEngineTitle.textContent = '⚠️ Setup Required';
    if (drawerBackendTarget) drawerBackendTarget.textContent = 'Enter Gemini Key or Heroku URL';
    if (setupAlertBanner) setupAlertBanner.style.display = 'flex';
  }
}

function updateFileCounts() {
  const count = Object.keys(workspaceFiles).length;
  const drawerFileCount = document.getElementById('drawer-file-count');
  const modalCount = document.getElementById('modal-file-count');
  if (drawerFileCount) drawerFileCount.textContent = count;
  if (modalCount) modalCount.textContent = count;
}

function saveWorkspace() {
  localStorage.setItem('kawat_workspace_files', JSON.stringify(workspaceFiles));
}

// ==========================================
// 4. WebSocket & Remote Resolution
// ==========================================
async function resolveBackendAndConnect() {
  if (VERCEL_GATEWAY) {
    try {
      const res = await fetch(`${VERCEL_GATEWAY.replace(/\/$/, '')}/api/config`, { signal: AbortSignal.timeout(2500) });
      if (res.ok) {
        const data = await res.json();
        if (data.backend_url) {
          ACTIVE_BACKEND = data.backend_url;
          localStorage.setItem('kawat_backend_url', ACTIVE_BACKEND);
        }
      }
    } catch (e) {}
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
        console.error(e);
      }
    };
  } catch (e) {
    isHerokuConnected = false;
    evaluateEngineStatus();
  }
}

// ==========================================
// 5. Send Prompt & Execution Loop
// ==========================================
async function sendPrompt() {
  const promptInput = document.getElementById('prompt-input');
  if (!promptInput) return;
  const text = promptInput.value.trim();
  if (!text) return;

  if (!isHerokuConnected && !GEMINI_API_KEY) {
    openBackendModal();
    return;
  }

  const welcomeHero = document.getElementById('welcome-hero');
  if (welcomeHero) welcomeHero.style.display = 'none';

  appendUserMessage(text);
  promptInput.value = '';
  promptInput.style.height = 'auto';

  currentAgentTurn = createAgentTurnContainer();
  currentToolCard = null;

  if (isHerokuConnected && ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      prompt: text,
      api_key: GEMINI_API_KEY,
      model: ACTIVE_MODEL
    }));
  } else {
    await executeClientAgentTurn(text);
  }
}
window.sendPrompt = sendPrompt;

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

    const functionCalls = [];
    let textResponse = '';

    for (const part of (content.parts || [])) {
      if (part.functionCall) functionCalls.push(part.functionCall);
      if (part.text) textResponse += part.text;
    }

    if (functionCalls.length === 0) {
      handleAgentEvent({ type: 'done', text: textResponse });
      break;
    }

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

async function executeClientGithubPush(repoName, token) {
  if (!token) return { success: false, error: 'GitHub Token is required.' };
  try {
    const cleanToken = token.trim();
    const userRes = await fetch('https://api.github.com/user', {
      headers: { 'Authorization': `token ${cleanToken}`, 'Accept': 'application/vnd.github.v3+json' }
    });
    if (!userRes.ok) return { success: false, error: 'Invalid GitHub Token.' };
    const userData = await userRes.json();
    const username = userData.login;

    await fetch('https://api.github.com/user/repos', {
      method: 'POST',
      headers: { 'Authorization': `token ${cleanToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: repoName, description: 'Created autonomously by KAWAT Agent', private: false })
    });

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

// ==========================================
// 6. Event Rendering
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
      if (header) header.appendChild(badge);

      let summary = '';
      if (event.result.message) summary = event.result.message;
      else if (event.result.output) summary = event.result.output;
      else if (event.result.repo_url) summary = `Created: <a href="${event.result.repo_url}" target="_blank" style="color:#60a5fa; font-weight:600;">${event.result.repo_url}</a>`;
      else if (event.result.error) summary = `Error: ${event.result.error}`;
      else summary = JSON.stringify(event.result);

      if (body) body.innerHTML = summary;
    }
    updateFileCounts();
  }
  else if (event.type === 'done') {
    const thinkBox = currentAgentTurn.querySelector('.thinking-step');
    if (thinkBox) thinkBox.remove();

    if (event.text) {
      const textDiv = document.createElement('div');
      textDiv.className = 'agent-text-content';
      textDiv.innerHTML = typeof marked !== 'undefined' ? marked.parse(event.text) : event.text;
      currentAgentTurn.appendChild(textDiv);
      if (typeof Prism !== 'undefined') Prism.highlightAllUnder(textDiv);
    }
  }
  else if (event.type === 'error') {
    appendSystemNotice(event.message || 'Error occurred', 'error');
  }

  scrollToBottom();
}

function appendUserMessage(text) {
  const messagesFeed = document.getElementById('messages-feed');
  if (!messagesFeed) return;
  const div = document.createElement('div');
  div.className = 'message-user';
  div.textContent = text;
  messagesFeed.appendChild(div);
  scrollToBottom();
}

function createAgentTurnContainer() {
  const messagesFeed = document.getElementById('messages-feed');
  const div = document.createElement('div');
  div.className = 'message-agent';
  if (messagesFeed) messagesFeed.appendChild(div);
  scrollToBottom();
  return div;
}

function appendSystemNotice(text, type = 'info') {
  const messagesFeed = document.getElementById('messages-feed');
  const div = document.createElement('div');
  div.className = `tool-card ${type}`;
  div.innerHTML = `<span style="color:#f59e0b;">⚠️ ${text}</span>`;
  if (messagesFeed) messagesFeed.appendChild(div);
  scrollToBottom();
}

function scrollToBottom() {
  const container = document.getElementById('chat-container');
  if (container) container.scrollTop = container.scrollHeight;
}

// ==========================================
// 7. Event Listener Initializer (Self-Healing)
// ==========================================
function setupEventListeners() {
  try {
    const btnOpenDrawer = document.getElementById('btn-open-drawer');
    if (btnOpenDrawer) btnOpenDrawer.onclick = () => toggleDrawer(true);

    const btnCloseDrawer = document.getElementById('btn-close-drawer');
    if (btnCloseDrawer) btnCloseDrawer.onclick = () => toggleDrawer(false);

    const drawerOverlay = document.getElementById('drawer-overlay');
    if (drawerOverlay) drawerOverlay.onclick = () => toggleDrawer(false);

    const btnNewChat = document.getElementById('btn-new-chat');
    if (btnNewChat) btnNewChat.onclick = startNewSession;

    const btnModelSelect = document.getElementById('btn-model-select');
    if (btnModelSelect) btnModelSelect.onclick = openBackendModal;

    const promptInput = document.getElementById('prompt-input');
    if (promptInput) {
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
    }

    const btnSend = document.getElementById('btn-send');
    if (btnSend) btnSend.onclick = sendPrompt;

    const btnAttach = document.getElementById('btn-attach');
    if (btnAttach) btnAttach.onclick = openWorkspaceTab;

    const btnMic = document.getElementById('btn-mic');
    if (btnMic) btnMic.onclick = triggerVoice;
  } catch (err) {
    console.error("setupEventListeners error:", err);
  }
}

// Robust App Bootloader (Runs whether DOM is already ready or loading)
function initApp() {
  try {
    setupEventListeners();
    updateUIFromState();
    updateFileCounts();

    if (ACTIVE_BACKEND || VERCEL_GATEWAY) {
      resolveBackendAndConnect();
    } else {
      evaluateEngineStatus();
    }
  } catch (e) {
    console.error("KAWAT init error:", e);
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initApp);
} else {
  initApp();
}
