# ⚡ KAWAT AI — Heroku Autonomous Agent Backend

Autonomous coding agent backend designed for Heroku hosting with monthly rotation capability.

## 🚀 How to Deploy on Heroku (Every Month)

### Method 1: Using Heroku CLI
```bash
# 1. Login to Heroku (your current month's account)
heroku login

# 2. Create new app
heroku create kawat-agent-$(date +%s)

# 3. Set Config Vars
heroku config:set GEMINI_API_KEY="your-gemini-api-key"
heroku config:set DEFAULT_MODEL="gemini-2.0-flash"

# 4. Deploy!
git init
git add .
git commit -m "Deploy Kawat Backend"
heroku git:remote -a <your-app-name>
git push heroku master
```

### Method 2: Deploy via GitHub (Easiest)
1. Push this folder to a GitHub repository (e.g. `kawat-backend`).
2. In Heroku Dashboard, click **New App** $\rightarrow$ **Connect to GitHub** $\rightarrow$ Click **Deploy Branch**.
3. Under **Settings $\rightarrow$ Config Vars**, add:
   - `GEMINI_API_KEY`: Your Gemini API key from Google AI Studio.
4. Copy your app URL (e.g., `https://kawat-agent-123.herokuapp.com`).
5. Go to your Vercel gateway at `https://kawatai.vercel.app` and update the backend URL.
6. **Done!** Your phone app automatically switches to this new backend immediately.

## 🛠️ Included Agent Capabilities
- **File System Operations**: Read, write, diff edit, list, and download project files.
- **Terminal Execution**: Runs shell and python commands inside the workspace.
- **GitHub Tool**: Creates repos and pushes code with personal access tokens.
- **Telegram Bot Bridge**: Sends alerts and generated links to Telegram chats.
- **WebSocket Streaming**: Ultra-fast token-by-token and live tool card streaming.
