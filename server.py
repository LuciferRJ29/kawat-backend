import asyncio
import io
import os
import zipfile
from pathlib import Path
from typing import Optional, Dict, Any

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from config import BASE_DIR, WORKSPACE_DIR, GEMINI_API_KEY, DEFAULT_MODEL
from agent import KawatAgent
from tools import run_command, push_to_github

app = FastAPI(title="KAWAT Autonomous Agent Backend", version="2.0.0")

# Enable CORS for Vercel Gateway and Mobile App
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

STATIC_DIR = BASE_DIR / "static"
STATIC_DIR.mkdir(exist_ok=True)

current_config = {
    "api_key": GEMINI_API_KEY,
    "access_token": os.getenv("GOOGLE_ACCESS_TOKEN", ""),
    "model": DEFAULT_MODEL,
}

class SettingsPayload(BaseModel):
    api_key: Optional[str] = None
    access_token: Optional[str] = None
    model: Optional[str] = None

class RunCommandPayload(BaseModel):
    command: str

class SaveFilePayload(BaseModel):
    path: str
    content: str

class GithubPushPayload(BaseModel):
    repo_name: str
    github_token: str
    is_private: bool = False
    commit_message: Optional[str] = "Update by Kawat Agent"

@app.get("/api/status")
async def get_status():
    file_count = sum(1 for _ in WORKSPACE_DIR.rglob("*") if _.is_file())
    is_authenticated = bool(current_config["access_token"] or current_config["api_key"])
    return {
        "status": "online",
        "agent": "KAWAT AI",
        "authenticated": is_authenticated,
        "model": current_config["model"],
        "workspace_files": file_count,
        "workspace_dir": str(WORKSPACE_DIR)
    }

@app.post("/api/settings")
async def update_settings(payload: SettingsPayload):
    if payload.api_key is not None:
        current_config["api_key"] = payload.api_key
    if payload.access_token is not None:
        current_config["access_token"] = payload.access_token
    if payload.model is not None:
        current_config["model"] = payload.model
    return {"success": True, "config": current_config}

@app.get("/api/files")
async def list_files():
    tree = []
    for root, dirs, files in os.walk(WORKSPACE_DIR):
        r_path = Path(root)
        rel_root = r_path.relative_to(WORKSPACE_DIR).as_posix()
        if rel_root == ".":
            rel_root = ""
        for d in dirs:
            if d.startswith(".") or d == "__pycache__":
                continue
            tree.append({
                "path": f"{rel_root}/{d}".lstrip("/"),
                "is_dir": True,
                "name": d
            })
        for f in files:
            if f.startswith("."):
                continue
            full_p = r_path / f
            tree.append({
                "path": f"{rel_root}/{f}".lstrip("/"),
                "is_dir": False,
                "name": f,
                "size": full_p.stat().st_size
            })
    return {"files": sorted(tree, key=lambda x: (not x["is_dir"], x["path"]))}

@app.get("/api/files/content")
async def get_file_content(path: str = Query(..., description="Relative file path")):
    target = (WORKSPACE_DIR / path).resolve()
    if not target.is_relative_to(WORKSPACE_DIR.resolve()) or not target.exists():
        raise HTTPException(status_code=404, detail="File not found")
    try:
        content = target.read_text(encoding="utf-8", errors="replace")
        return {"path": path, "content": content}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/files/save")
async def save_file(payload: SaveFilePayload):
    target = (WORKSPACE_DIR / payload.path).resolve()
    if not target.is_relative_to(WORKSPACE_DIR.resolve()):
        raise HTTPException(status_code=403, detail="Invalid path outside workspace")
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(payload.content, encoding="utf-8")
    return {"success": True, "message": f"Saved {payload.path}"}

@app.post("/api/terminal/run")
async def terminal_run(payload: RunCommandPayload):
    res = await run_command(payload.command)
    return res

@app.post("/api/github/push")
async def github_push(payload: GithubPushPayload):
    res = await push_to_github(
        repo_name=payload.repo_name,
        github_token=payload.github_token,
        is_private=payload.is_private,
        commit_message=payload.commit_message or "Commit from Kawat Agent"
    )
    return res

@app.get("/api/download-zip")
async def download_workspace_zip():
    zip_buffer = io.BytesIO()
    with zipfile.ZipFile(zip_buffer, "w", zipfile.ZIP_DEFLATED) as zip_file:
        for root, dirs, files in os.walk(WORKSPACE_DIR):
            for file in files:
                if file.startswith(".") or "__pycache__" in root:
                    continue
                file_path = Path(root) / file
                archive_name = file_path.relative_to(WORKSPACE_DIR).as_posix()
                zip_file.write(file_path, archive_name)
    zip_buffer.seek(0)
    return StreamingResponse(
        zip_buffer,
        media_type="application/zip",
        headers={"Content-Disposition": "attachment; filename=kawat_workspace.zip"}
    )

# WebSocket Real-Time Chat & Agent Streaming
@app.websocket("/ws/chat")
async def websocket_agent_chat(websocket: WebSocket):
    await websocket.accept()
    agent_history = []

    try:
        while True:
            data = await websocket.receive_json()
            user_prompt = data.get("prompt", "").strip()
            api_key = data.get("api_key") or current_config["api_key"]
            access_token = data.get("access_token") or current_config["access_token"]
            model = data.get("model") or current_config["model"]

            if not user_prompt:
                continue

            agent = KawatAgent(api_key=api_key, access_token=access_token, model_name=model)

            async def event_callback(event: Dict[str, Any]):
                await websocket.send_json(event)

            final_reply = await agent.execute_turn(
                user_prompt=user_prompt,
                conversation_history=agent_history,
                event_callback=event_callback
            )
            agent_history.append({"user": user_prompt, "agent": final_reply})

    except WebSocketDisconnect:
        pass
    except Exception as e:
        try:
            await websocket.send_json({"type": "error", "message": str(e)})
        except Exception:
            pass

# Serve static files (mobile app web version)
if STATIC_DIR.exists():
    app.mount("/", StaticFiles(directory=str(STATIC_DIR), html=True), name="static")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("server:app", host="0.0.0.0", port=int(os.getenv("PORT", 8000)), reload=True)
