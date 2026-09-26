import asyncio
import json
import logging
from typing import Dict, Any, List, Optional, Callable, Awaitable
import google.generativeai as genai
from google.generativeai.types import FunctionDeclaration, Tool

from config import DEFAULT_MODEL, MAX_AGENT_STEPS
from tools import GEMINI_TOOLS_DECLARATION, TOOL_EXECUTORS

logger = logging.getLogger("kawat_agent")

SYSTEM_INSTRUCTION = """You are KAWAT AI — a 100% autonomous AI coding agent designed to run from a mobile phone interface.
You do NOT just chat or provide advice; you take action. You have hands and tools.

Core Principles:
1. Always Use Tools:
   - When asked to create or build a bot/app, write the code directly into files using `write_to_file`.
   - When asked to modify or fix a file ("file me ye change kar"), first inspect the lines using `view_file`, then modify it using `replace_file_content` or `write_to_file`.
   - When asked to push to GitHub, collect/use the token and call `push_to_github`.
   - When asked to test or run code, execute it with `run_command`.
2. Communication Style:
   - Friendly, confident, bilingual (Hinglish/Hindi/English) as preferred by user.
   - Concise summary after performing actions. Do not dump large walls of code in plain text when you have already created the file. Give clickable or clean file references.
3. Autonomous Problem Solving:
   - If a command fails or a file edit fails, do NOT stop immediately. Read the error output, inspect the file, correct the syntax or parameters, and retry.
4. Telegram Bot Building:
   - When building a Telegram bot, create clean modular code (main bot runner, handlers, requirements.txt, .env.example, README.md).
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

        try:
            model = genai.GenerativeModel(
                model_name=self.model_name,
                system_instruction=SYSTEM_INSTRUCTION,
                tools=tools
            )
            chat = model.start_chat(enable_automatic_function_calling=False)
        except Exception as e:
            # Fallback to standard 1.5 flash if model name not recognized
            model = genai.GenerativeModel(
                model_name="gemini-1.5-flash",
                system_instruction=SYSTEM_INSTRUCTION,
                tools=tools
            )
            chat = model.start_chat(enable_automatic_function_calling=False)

        # Reconstruct past context if any
        current_prompt = user_prompt
        step = 0
        final_text = ""

        while step < MAX_AGENT_STEPS:
            step += 1
            await event_callback({
                "type": "thinking",
                "step": step,
                "status": "Analyzing and planning next action..."
            })

            try:
                response = await asyncio.to_thread(chat.send_message, current_prompt)
            except Exception as e:
                err_msg = f"LLM Generation Error: {str(e)}"
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

            for candidate in response.candidates:
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

            current_prompt = tool_responses

        if step >= MAX_AGENT_STEPS and not final_text:
            final_text = "Task reached maximum autonomous steps limit."
            await event_callback({"type": "done", "text": final_text})

        return final_text
