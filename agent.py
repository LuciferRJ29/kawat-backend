import asyncio
import json
import logging
from typing import Dict, Any, List, Optional, Callable, Awaitable
import google.generativeai as genai
from google.generativeai.types import FunctionDeclaration, Tool

from config import DEFAULT_MODEL, MAX_AGENT_STEPS
from tools import GEMINI_TOOLS_DECLARATION, TOOL_EXECUTORS

logger = logging.getLogger("kawat_agent")

SYSTEM_INSTRUCTION = """You are KAWAT AI — a versatile, powerful, and 100% autonomous AI agent designed by the Kawat team.
You are built to assist the user with ANY task, just like Antigravity, ChatGPT, Claude, and Gemini:

Capabilities:
1. Complete Coding & Software Development:
   - Create, build, and deploy entire applications, Telegram bots, REST APIs, HTML/CSS/JS web applications, Python automation scripts, games, scrapers, tools, and calculators.
   - Always write complete, production-ready code directly into files using `write_to_file`. Never leave placeholders like `// TODO` or `...`.
2. Autonomous File Inspection & Editing:
   - When asked to fix, modify, or add features to a file ("ye change kar", "ye error fix kar"):
     First inspect the file using `view_file` to see exact line numbers.
     Then update the code cleanly using `replace_file_content` or `write_to_file`.
3. Working with Files & Phone Storage:
   - When the user asks about files or mentions files on their phone (e.g. "mere phone me zip file dekh", "ye zip inspect kar"):
     First check what files exist in the project workspace with `list_dir`.
     If the user wants to work with a file from their phone, warmly guide them:
     "Aap bottom bar me '+' (attachment) button pe tap karke apne phone storage se koi bhi zip file, python file ya code upload kar sakte ho! Jaise hi aap upload karoge, mai use turant workspace me extract/inspect karke modify kar dunga."
4. GitHub Integration:
   - Push projects directly to GitHub with `push_to_github` when requested, using the repository name and token provided.
5. Terminal & Code Execution:
   - Run tests, scripts, or package installations using `run_command` in the workspace.
6. Universal Knowledge & General Tasks:
   - You can do ANY task: answer technical questions, explain complex concepts, solve mathematics and logic, write essays, summarize documents, debug errors, brainstorm ideas, translate text, and converse naturally.
   - For general questions and conversation, answer directly, smartly, and comprehensively without forcing unnecessary tool calls.
7. Tone & Language:
   - Confident, helpful, friendly, speaking in natural bilingual Hindi/Hinglish or English as the user prefers.
"""

class KawatAgent:
    def __init__(self, api_key: Optional[str] = None, access_token: Optional[str] = None, model_name: Optional[str] = None):
        self.api_key = api_key
        self.access_token = access_token
        self.model_name = model_name or DEFAULT_MODEL
        self._init_gemini()

    def _init_gemini(self):
        if self.api_key:
            genai.configure(api_key=self.api_key)
        elif self.access_token:
            genai.configure(credentials={"token": self.access_token})

    def _convert_schema_to_gemini(self, decl_list: List[Dict[str, Any]]) -> List[Tool]:
        func_decls = []
        for d in decl_list:
            fd = FunctionDeclaration(
                name=d["name"],
                description=d["description"],
                parameters=d.get("parameters")
            )
            func_decls.append(fd)
        return [Tool(function_declarations=func_decls)]

    async def execute_turn(
        self,
        user_prompt: str,
        conversation_history: List[Dict[str, Any]],
        event_callback: Callable[[Dict[str, Any]], Awaitable[None]]
    ) -> str:
        """Executes an autonomous ReAct loop until task completion or max steps."""
        if not self.api_key and not self.access_token:
            await event_callback({
                "type": "error",
                "message": "No API key or Google Login found. Please provide Gemini API key in settings or sign in."
            })
            return "Missing API Key"

        tools = self._convert_schema_to_gemini(GEMINI_TOOLS_DECLARATION)
        current_model_name = self.model_name

        def _create_model(m_name: str):
            return genai.GenerativeModel(
                model_name=m_name,
                system_instruction=SYSTEM_INSTRUCTION,
                tools=tools
            )

        try:
            model = _create_model(current_model_name)
            chat = model.start_chat(enable_automatic_function_calling=False)
        except Exception:
            current_model_name = "gemini-2.0-flash"
            model = _create_model(current_model_name)
            chat = model.start_chat(enable_automatic_function_calling=False)

        current_prompt = user_prompt
        step = 0
        final_text = ""

        while step < MAX_AGENT_STEPS:
            step += 1
            await event_callback({
                "type": "thinking",
                "step": step,
                "status": "Analyzing request & planning next steps..."
            })

            try:
                response = await asyncio.to_thread(chat.send_message, current_prompt)
            except Exception as e:
                err_str = str(e)
                # Catch 429 quota exhaustion or rate limits
                if "429" in err_str or "ResourceExhausted" in err_str or "quota" in err_str.lower():
                    fallback_model = "gemini-2.0-flash" if "2.0" not in current_model_name else "gemini-1.5-flash"
                    await event_callback({
                        "type": "thinking",
                        "step": step,
                        "status": f"⚡ Rate limit reached. Seamlessly switching to high-quota engine ({fallback_model})..."
                    })
                    try:
                        current_model_name = fallback_model
                        model = _create_model(current_model_name)
                        # Re-start chat with previous history if available
                        history = chat.history if hasattr(chat, 'history') else None
                        chat = model.start_chat(history=history, enable_automatic_function_calling=False)
                        await asyncio.sleep(1.5)
                        response = await asyncio.to_thread(chat.send_message, current_prompt)
                    except Exception as retry_err:
                        err_msg = f"LLM Generation Error: {str(retry_err)}"
                        await event_callback({"type": "error", "message": err_msg})
                        return err_msg
                else:
                    err_msg = f"LLM Generation Error: {err_str}"
                    await event_callback({"type": "error", "message": err_msg})
                    return err_msg

            # Check if model emitted text
            part_text = ""
            try:
                part_text = response.text or ""
            except Exception:
                part_text = ""

            # Check for function calls
            has_func_calls = False
            func_calls = []

            for candidate in (response.candidates or []):
                if candidate.content and candidate.content.parts:
                    for part in candidate.content.parts:
                        if hasattr(part, "function_call") and part.function_call:
                            has_func_calls = True
                            func_calls.append(part.function_call)

            if not has_func_calls:
                final_text = part_text
                await event_callback({
                    "type": "done",
                    "text": final_text
                })
                break

            # Execute all function calls
            tool_responses = []
            for fc in func_calls:
                fn_name = fc.name
                fn_args = dict(fc.args)

                await event_callback({
                    "type": "tool_start",
                    "tool": fn_name,
                    "args": fn_args
                })

                executor = TOOL_EXECUTORS.get(fn_name)
                if executor:
                    try:
                        obs = await executor(**fn_args)
                    except Exception as ex:
                        obs = {"success": False, "error": f"Tool execution failed: {str(ex)}"}
                else:
                    obs = {"success": False, "error": f"Unknown tool: {fn_name}"}

                await event_callback({
                    "type": "tool_end",
                    "tool": fn_name,
                    "result": obs
                })

                tool_responses.append({
                    "function_response": {
                        "name": fn_name,
                        "response": {"result": obs}
                    }
                })

            # Small delay between tool steps to stay well below RPM limits
            await asyncio.sleep(1.2)
            current_prompt = tool_responses

        if step >= MAX_AGENT_STEPS and not final_text:
            final_text = "Task reached maximum autonomous steps limit."
            await event_callback({"type": "done", "text": final_text})

        return final_text
