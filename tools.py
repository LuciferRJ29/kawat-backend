import asyncio
import os
import shutil
from pathlib import Path
from typing import Dict, Any, Optional, List
from config import WORKSPACE_DIR

try:
    from duckduckgo_search import DDGS
    HAS_DDGS = True
except ImportError:
    HAS_DDGS = False

try:
    from github import Github, GithubException
    HAS_PYGITHUB = True
except ImportError:
    HAS_PYGITHUB = False

try:
    import httpx
    HAS_HTTPX = True
except ImportError:
    HAS_HTTPX = False


def resolve_path(target_path: str) -> Path:
    """Resolve a path safely inside or relative to the workspace."""
    p = Path(target_path)
    if not p.is_absolute():
        p = (WORKSPACE_DIR / p).resolve()
    else:
        p = p.resolve()
    return p


async def run_command(command: str, cwd: Optional[str] = None, timeout: int = 60) -> Dict[str, Any]:
    """Runs a shell command inside the workspace directory."""
    work_dir = resolve_path(cwd) if cwd else WORKSPACE_DIR
    work_dir.mkdir(parents=True, exist_ok=True)

    try:
        proc = await asyncio.create_subprocess_shell(
            command,
            cwd=str(work_dir),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        try:
            stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout)
            out = stdout.decode("utf-8", errors="replace").strip()
            err = stderr.decode("utf-8", errors="replace").strip()
            return {
                "success": proc.returncode == 0,
                "exit_code": proc.returncode,
                "output": (out + ("\n" + err if err else "")).strip() or "(No output)"
            }
        except asyncio.TimeoutError:
            proc.kill()
            return {"success": False, "exit_code": -1, "output": f"Command timed out after {timeout} seconds."}
    except Exception as e:
        return {"success": False, "exit_code": -1, "output": f"Execution error: {str(e)}"}


async def write_to_file(target_file: str, content: str, overwrite: bool = True) -> Dict[str, Any]:
    """Creates or overwrites a file inside the workspace."""
    try:
        path = resolve_path(target_file)
        path.parent.mkdir(parents=True, exist_ok=True)
        if path.exists() and not overwrite:
            return {"success": False, "error": f"File '{target_file}' already exists and overwrite is set to False."}
        
        path.write_text(content, encoding="utf-8")
        return {"success": True, "message": f"Successfully wrote {len(content)} characters to '{path.name}'."}
    except Exception as e:
        return {"success": False, "error": str(e)}


async def replace_file_content(target_file: str, target_content: str, replacement_content: str) -> Dict[str, Any]:
    """Replaces a precise block of text inside an existing file."""
    try:
        path = resolve_path(target_file)
        if not path.exists():
            return {"success": False, "error": f"File '{target_file}' not found."}

        text = path.read_text(encoding="utf-8")
        if target_content not in text:
            return {"success": False, "error": f"Target content not found in '{target_file}'. Please inspect file with view_file first."}

        new_text = text.replace(target_content, replacement_content, 1)
        path.write_text(new_text, encoding="utf-8")
        return {"success": True, "message": f"Successfully updated '{target_file}'."}
    except Exception as e:
        return {"success": False, "error": str(e)}


async def view_file(target_file: str, start_line: Optional[int] = None, end_line: Optional[int] = None) -> Dict[str, Any]:
    """Views lines of a file with line numbers."""
    try:
        path = resolve_path(target_file)
        if not path.exists():
            return {"success": False, "error": f"File '{target_file}' does not exist."}

        lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
        total_lines = len(lines)

        s = max(1, start_line or 1)
        e = min(total_lines, end_line or total_lines)

        selected = [f"{i}: {lines[i-1]}" for i in range(s, e + 1)]
        content = "\n".join(selected)
        return {
            "success": True,
            "total_lines": total_lines,
            "start_line": s,
            "end_line": e,
            "content": content or "(Empty file)"
        }
    except Exception as e:
        return {"success": False, "error": str(e)}


async def list_dir(directory_path: Optional[str] = None) -> Dict[str, Any]:
    """Lists files and folders in a workspace directory."""
    try:
        path = resolve_path(directory_path) if directory_path else WORKSPACE_DIR
        if not path.exists():
            return {"success": False, "error": f"Directory '{path}' does not exist."}

        items = []
        for item in sorted(path.iterdir()):
            items.append({
                "name": item.name,
                "is_dir": item.is_dir(),
                "size_bytes": item.stat().st_size if item.is_file() else None
            })
        return {"success": True, "directory": str(path.relative_to(WORKSPACE_DIR) if path != WORKSPACE_DIR else "."), "items": items}
    except Exception as e:
        return {"success": False, "error": str(e)}


async def search_web(query: str, max_results: int = 5) -> Dict[str, Any]:
    """Searches the internet for documentation, tutorials, or error fixes."""
    if not HAS_DDGS:
        return {"success": False, "error": "duckduckgo_search library is not installed."}
    try:
        loop = asyncio.get_running_loop()
        def _search():
            with DDGS() as ddgs:
                return list(ddgs.text(query, max_results=max_results))
        results = await loop.run_in_executor(None, _search)
        return {"success": True, "results": results}
    except Exception as e:
        return {"success": False, "error": str(e)}


async def push_to_github(
    repo_name: str,
    github_token: str,
    is_private: bool = False,
    commit_message: str = "Initial commit by Kawat Agent",
    subfolder: Optional[str] = None
) -> Dict[str, Any]:
    """Creates a GitHub repository and pushes workspace files using personal access token."""
    if not HAS_PYGITHUB:
        return {"success": False, "error": "PyGithub library is not installed."}
    
    try:
        loop = asyncio.get_running_loop()
        def _push():
            g = Github(github_token.strip())
            user = g.get_user()
            
            # Check or create repo
            try:
                repo = user.get_repo(repo_name)
            except GithubException:
                repo = user.create_repo(repo_name, private=is_private, description="Built autonomously by Kawat AI Agent")

            target_dir = resolve_path(subfolder) if subfolder else WORKSPACE_DIR
            pushed_files = []

            for root, _, files in os.walk(target_dir):
                for f in files:
                    full_p = Path(root) / f
                    rel_p = full_p.relative_to(target_dir).as_posix()
                    
                    # Ignore git and pycache
                    if ".git" in rel_p or "__pycache__" in rel_p:
                        continue
                    
                    try:
                        content = full_p.read_bytes()
                        try:
                            # Update existing file
                            existing_file = repo.get_contents(rel_p)
                            repo.update_file(existing_file.path, commit_message, content, existing_file.sha)
                        except GithubException:
                            # Create new file
                            repo.create_file(rel_p, commit_message, content)
                        pushed_files.append(rel_p)
                    except Exception as fe:
                        print(f"File push skipped for {rel_p}: {fe}")

            return {
                "success": True,
                "repo_url": repo.html_url,
                "pushed_count": len(pushed_files),
                "files": pushed_files
            }

        res = await loop.run_in_executor(None, _push)
        return res
    except Exception as e:
        return {"success": False, "error": f"GitHub Push Failed: {str(e)}"}


async def telegram_send_alert(bot_token: str, chat_id: str, message: str) -> Dict[str, Any]:
    """Sends a message or notification to a Telegram user/chat using bot token."""
    if not HAS_HTTPX:
        return {"success": False, "error": "httpx library is not installed."}
    try:
        url = f"https://api.telegram.org/bot{bot_token.strip()}/sendMessage"
        payload = {
            "chat_id": chat_id.strip(),
            "text": message,
            "parse_mode": "Markdown"
        }
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.post(url, json=payload)
            if resp.status_code == 200:
                return {"success": True, "message": "Telegram message delivered."}
            else:
                return {"success": False, "error": f"Telegram API error: {resp.text}"}
    except Exception as e:
        return {"success": False, "error": str(e)}


# Gemini Tool Declaration Schemas
GEMINI_TOOLS_DECLARATION = [
    {
        "name": "run_command",
        "description": "Execute a terminal shell command inside the workspace directory (e.g. python script.py, pip install, git status, pytest, npm).",
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "command": {"type": "STRING", "description": "The exact command line string to run."},
                "cwd": {"type": "STRING", "description": "Optional subdirectory relative to workspace."}
            },
            "required": ["command"]
        }
    },
    {
        "name": "write_to_file",
        "description": "Create or overwrite a file with code or text inside the project workspace.",
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "target_file": {"type": "STRING", "description": "Relative file path inside workspace (e.g. 'main.py' or 'bot/handlers.py')."},
                "content": {"type": "STRING", "description": "The complete source code or text to write."},
                "overwrite": {"type": "BOOLEAN", "description": "Whether to overwrite if file already exists (default true)."}
            },
            "required": ["target_file", "content"]
        }
    },
    {
        "name": "replace_file_content",
        "description": "Edit an existing file by replacing a specific target block of text with new replacement code.",
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "target_file": {"type": "STRING", "description": "Path to the file to modify."},
                "target_content": {"type": "STRING", "description": "Exact text inside the file to be replaced."},
                "replacement_content": {"type": "STRING", "description": "New replacement text."}
            },
            "required": ["target_file", "target_content", "replacement_content"]
        }
    },
    {
        "name": "view_file",
        "description": "Read file contents with numbered lines to inspect existing code before editing.",
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "target_file": {"type": "STRING", "description": "Path of the file to inspect."},
                "start_line": {"type": "INTEGER", "description": "Optional start line number (1-indexed)."},
                "end_line": {"type": "INTEGER", "description": "Optional end line number (1-indexed)."}
            },
            "required": ["target_file"]
        }
    },
    {
        "name": "list_dir",
        "description": "List files and subfolders in workspace to understand project structure.",
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "directory_path": {"type": "STRING", "description": "Optional relative subfolder path. Defaults to root workspace."}
            }
        }
    },
    {
        "name": "search_web",
        "description": "Search the live web for error solutions, documentation, API references, or library examples.",
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "query": {"type": "STRING", "description": "Search query."}
            },
            "required": ["query"]
        }
    },
    {
        "name": "push_to_github",
        "description": "Create a GitHub repository and push code using the user's GitHub Personal Access Token.",
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "repo_name": {"type": "STRING", "description": "Name for the GitHub repository."},
                "github_token": {"type": "STRING", "description": "User's GitHub Personal Access Token (ghp_...)."},
                "is_private": {"type": "BOOLEAN", "description": "Whether repo should be private (default false)."},
                "commit_message": {"type": "STRING", "description": "Commit message for the push."},
                "subfolder": {"type": "STRING", "description": "Optional subfolder to push."}
            },
            "required": ["repo_name", "github_token"]
        }
    },
    {
        "name": "telegram_send_alert",
        "description": "Send a notification or generated link to Telegram.",
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "bot_token": {"type": "STRING", "description": "Telegram bot token."},
                "chat_id": {"type": "STRING", "description": "Telegram chat ID."},
                "message": {"type": "STRING", "description": "Message to send."}
            },
            "required": ["bot_token", "chat_id", "message"]
        }
    }
]

TOOL_EXECUTORS = {
    "run_command": run_command,
    "write_to_file": write_to_file,
    "replace_file_content": replace_file_content,
    "view_file": view_file,
    "list_dir": list_dir,
    "search_web": search_web,
    "push_to_github": push_to_github,
    "telegram_send_alert": telegram_send_alert,
}
