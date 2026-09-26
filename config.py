import os
from pathlib import Path
from dotenv import load_dotenv

load_dotenv()

BASE_DIR = Path(__file__).resolve().parent
WORKSPACE_DIR = BASE_DIR / "workspace"
WORKSPACE_DIR.mkdir(exist_ok=True)

# Google OAuth Credentials (optional for direct login)
GOOGLE_CLIENT_ID = os.getenv("GOOGLE_CLIENT_ID", "")
GOOGLE_CLIENT_SECRET = os.getenv("GOOGLE_CLIENT_SECRET", "")

# Default Gemini API Key (can be injected via Heroku config vars or per-request from mobile)
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")

# Default Model: gemini-3.8-flash (High)
DEFAULT_MODEL = os.getenv("DEFAULT_MODEL", "gemini-3.8-flash")

# Default Telegram Bot Token (optional)
TELEGRAM_BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN", "")

# Max autonomous agent steps
MAX_AGENT_STEPS = int(os.getenv("MAX_AGENT_STEPS", "25"))
