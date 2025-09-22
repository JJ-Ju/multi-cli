"""Abstractions over the Grok SDK integration.

This module isolates all direct dependencies on the xAI Python SDK so the rest
of the sidecar can remain stable even if we swap implementations. The
implementation below wires the runtime to the official ``xai-sdk`` package and
translates between the Gemini CLI's JSON protocol and the SDK's Python objects.
"""

from __future__ import annotations

import json
import mimetypes
import os
import re
import threading
import uuid
from dataclasses import dataclass, field
from html.parser import HTMLParser
from pathlib import Path
from typing import Any, Callable, Dict, Iterable, Iterator, List, Optional
from urllib import request as urllib_request
from urllib.error import URLError

from google.protobuf.json_format import MessageToDict

try:  # pragma: no cover - exercised indirectly via service initialisation
    from xai_sdk import Client as _XaiClient
    from xai_sdk.chat import assistant as _chat_assistant
    from xai_sdk.chat import system as _chat_system
    from xai_sdk.chat import tool as _chat_tool
    from xai_sdk.chat import tool_result as _chat_tool_result
    from xai_sdk.chat import user as _chat_user
    from xai_sdk.chat import SearchParameters as _chat_search_parameters
except ImportError as exc:  # pragma: no cover - surfaced during initialise()
    _XAI_IMPORT_ERROR: Optional[Exception] = exc
else:  # pragma: no cover - simple assignment
    _XAI_IMPORT_ERROR = None


@dataclass
class ToolDefinition:
    name: str
    description: str
    schema: dict


@dataclass
class ChatEvent:
    """Represents a streaming event emitted during chat completion."""

    event: str
    payload: dict


@dataclass
class ChatResult:
    """Final response returned by chat completion."""

    message: dict
    usage: dict | None = None


class GrokServiceError(RuntimeError):
    """Generic error raised by the Grok service layer."""


@dataclass
class _PendingToolCall:
    call_id: str
    name: str
    event: threading.Event = field(default_factory=threading.Event)
    content: List[dict] | None = None
    is_error: bool = False


class _HtmlStripper(HTMLParser):
    """Minimal HTML to text converter used for web fetch responses."""

    def __init__(self) -> None:
        super().__init__()
        self._chunks: List[str] = []

    def handle_data(self, data: str) -> None:  # pragma: no cover - parser callback
        if data:
            self._chunks.append(data)

    def get_text(self) -> str:
        return " ".join(self._chunks)


def _strip_html(content: str) -> str:
    stripper = _HtmlStripper()
    try:
        stripper.feed(content)
    finally:
        stripper.close()
    return stripper.get_text()


MAX_FETCH_BYTES = 200_000


def _count_occurrences(haystack: str, needle: str) -> int:
    if not needle:
        return 0
    return haystack.count(needle)


DEFAULT_MODEL = "grok-4-fast-reasoning"


class GrokService:
    """Facade responsible for all xAI SDK interactions."""

    def __init__(
        self,
        *,
        client_factory: Callable[..., Any] | None = None,
    ) -> None:
        self._initialised = False
        self._tools: Dict[str, ToolDefinition] = {}
        self._tool_protos: Dict[str, Any] = {}
        self._config: dict | None = None
        self._client_factory = client_factory or self._default_client_factory
        self._client: Any | None = None
        self._pending_tool_calls: Dict[str, _PendingToolCall] = {}
        self._pending_lock = threading.Lock()

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------
    def initialise(self, *, api_key: str, model: str | None = None, **_: object) -> dict:
        if not api_key:
            raise GrokServiceError("API key is required to initialise Grok service")

        try:
            self._client = self._client_factory(api_key=api_key)
        except Exception as exc:  # pragma: no cover - defensive
            raise GrokServiceError(f"Failed to initialise Grok SDK client: {exc}") from exc

        resolved_model = self._select_model(model)
        self._config = {"api_key": api_key, "model": resolved_model}
        self._initialised = True

        has_collections = hasattr(self._client, "collections")
        return {
            "status": "ok",
            "capabilities": {"supportsCollections": has_collections},
        }

    # ------------------------------------------------------------------
    # Tools
    # ------------------------------------------------------------------
    def register_tools(self, tools: Iterable[ToolDefinition]) -> None:
        self._ensure_ready()
        self._tools = {tool.name: tool for tool in tools}
        self._tool_protos = {
            name: self._build_tool_proto(tool)
            for name, tool in self._tools.items()
        }

    # ------------------------------------------------------------------
    # Chat interactions
    # ------------------------------------------------------------------
    def validate(self, prompt: str) -> tuple[List[ChatEvent], dict]:
        self._ensure_ready()
        prompt_text = prompt or ""
        builder = self._message_builder("user")
        try:
            chat = self._client.chat.create(
                model=self._config.get("model", DEFAULT_MODEL),
                messages=[builder(prompt_text)],
                max_tokens=128,
            )
            response = chat.sample()
        except Exception as exc:  # pragma: no cover - defensive
            raise GrokServiceError(f"Validation request failed: {exc}") from exc

        text = response.content or ""
        events: List[ChatEvent] = []
        if text:
            events.append(ChatEvent(event="delta", payload={"text": text}))

        result = {"passed": "grok" in text.lower(), "rawResponse": text}
        return events, result

    def chat(
        self,
        *,
        messages: List[dict],
        tools: List[ToolDefinition],
        options: dict | None = None,
    ) -> tuple[Iterator[ChatEvent], ChatResult]:
        self._ensure_ready()
        if tools:
            self.register_tools(tools)

        tool_protos = self._tool_protos.values()
        chat_kwargs = self._translate_generation_options(options)

        try:
            chat = self._client.chat.create(
                model=self._config.get("model", DEFAULT_MODEL),
                conversation_id=chat_kwargs.pop("conversation_id", None),
                messages=self._to_sdk_messages(messages),
                tools=list(tool_protos) or None,
                **chat_kwargs,
            )
        except Exception as exc:  # pragma: no cover - defensive
            raise GrokServiceError(f"Failed to create Grok chat session: {exc}") from exc

        message_payload = {
            "role": "assistant",
            "content": [{"type": "text", "text": ""}],
        }
        result = ChatResult(message=message_payload, usage=None)

        def stream() -> Iterator[ChatEvent]:
            final_text = ""
            final_usage_proto: Any | None = None
            try:
                while True:
                    pending_cycle: List[_PendingToolCall] = []
                    for response, chunk in chat.stream():
                        final_usage_proto = response.usage
                        final_text = response.content or final_text
                        for choice in chunk.choices:
                            text_delta = choice.content
                            if text_delta:
                                yield ChatEvent(event="delta", payload={"text": text_delta})

                            tool_calls = getattr(choice, "tool_calls", []) or []
                            for tool_call in tool_calls:
                                function = getattr(tool_call, "function", None)
                                call_id = getattr(tool_call, "id", "") or f"tool-{uuid.uuid4().hex}"
                                name = getattr(function, "name", "") if function else ""
                                arguments = (
                                    getattr(function, "arguments", "") if function else ""
                                )
                                pending_state = self._register_pending_tool_call(
                                    call_id,
                                    name,
                                )
                                pending_cycle.append(pending_state)
                                payload = {
                                    "callId": call_id,
                                    "name": name,
                                    "arguments": arguments,
                                }
                                yield ChatEvent(event="toolCall", payload=payload)

                    if pending_cycle:
                        for pending in pending_cycle:
                            content, is_error = self._wait_for_tool_result(pending)
                            response_text = self._format_tool_result_content(content)
                            if is_error and response_text:
                                response_text = f"[tool-error] {response_text}"
                            elif is_error:
                                response_text = '[tool-error]'
                            if not response_text:
                                response_text = 'Tool returned no output.'
                            chat.append(_chat_tool_result(response_text))
                            self._unregister_pending_tool_call(pending.call_id)

                        final_text = ""
                        continue
                    break
            except Exception as exc:  # pragma: no cover - defensive
                raise GrokServiceError(f"Grok streaming failed: {exc}") from exc
            else:
                message_payload["content"][0]["text"] = final_text
                if final_usage_proto is not None:
                    result.usage = MessageToDict(
                        final_usage_proto,
                        preserving_proto_field_name=True,
                    ) or None

        return stream(), result

    # ------------------------------------------------------------------
    # Tooling helpers
    # ------------------------------------------------------------------
    def web_search(
        self,
        *,
        query: str,
        mode: str = "on",
        max_tokens: int | None = None,
    ) -> dict:
        self._ensure_ready()
        trimmed = (query or "").strip()
        if not trimmed:
            return {
                "llmContent": "No query provided for web search.",
                "returnDisplay": "No search executed.",
                "error": {"message": "Query cannot be empty."},
            }

        search_params = _chat_search_parameters(mode=mode or "on")
        user_message = self._message_builder("user")(trimmed)

        chat_kwargs: Dict[str, Any] = {
            "model": DEFAULT_MODEL,
            "messages": [user_message],
            "search_parameters": search_params,
        }
        if max_tokens is not None:
            chat_kwargs["max_tokens"] = max_tokens

        try:
            chat = self._client.chat.create(**chat_kwargs)
            response = chat.sample()
        except Exception as exc:  # pragma: no cover - dependency failure
            raise GrokServiceError(f"Web search failed: {exc}") from exc

        text = (response.content or "").strip()
        citations = list(response.citations or [])
        if not text:
            text = f'No search results found for "{trimmed}".'
            display = "No information found."
        else:
            display = f'Search results for "{trimmed}" returned.'

        result: Dict[str, Any] = {
            "llmContent": text,
            "returnDisplay": display,
        }
        if citations:
            result["sources"] = citations
        return result

    def web_fetch(
        self,
        *,
        prompt: str,
        max_tokens: int | None = None,
        fetch_timeout: float | None = 10.0,
    ) -> dict:
        self._ensure_ready()
        trimmed = (prompt or "").strip()
        if not trimmed:
            return {
                "llmContent": "No prompt supplied for web fetch.",
                "returnDisplay": "No web content fetched.",
                "error": {"message": "Prompt cannot be empty."},
            }

        urls = re.findall(r"https?://[^\s)]+", trimmed)
        first_url = urls[0] if urls else None
        fetched_text: Optional[str] = None
        fetch_error: Optional[str] = None

        if first_url:
            candidate = first_url.rstrip('.,)')
            try:
                with urllib_request.urlopen(candidate, timeout=fetch_timeout or 10.0) as handle:
                    raw_bytes = handle.read(MAX_FETCH_BYTES)
                    charset = handle.headers.get_content_charset() or "utf-8"
                decoded = raw_bytes.decode(charset, errors="ignore")
                fetched_text = _strip_html(decoded)
                first_url = candidate
            except (URLError, OSError, ValueError) as exc:
                fetch_error = f"Failed to fetch {candidate}: {exc}"

        summary_prompt_parts: List[str] = []
        if fetched_text:
            summary_prompt_parts.append(
                f"Summarize the following content retrieved from {first_url}:"
            )
            summary_prompt_parts.append(fetched_text[:6000])
        else:
            summary_prompt_parts.append(
                "The user requested information that may require browsing the web."
            )
            summary_prompt_parts.append(trimmed)

        user_payload = "\n\n".join(summary_prompt_parts)
        system_prompt = (
            "You are a helpful assistant that extracts key facts from fetched web content. "
            "Provide concise, factual summaries."
        )

        chat_kwargs: Dict[str, Any] = {
            "model": self._config.get("model", DEFAULT_MODEL),
            "messages": [
                self._message_builder("system")(system_prompt),
                self._message_builder("user")(user_payload),
            ],
            "search_parameters": _chat_search_parameters(mode="on"),
        }
        if max_tokens is not None:
            chat_kwargs["max_tokens"] = max_tokens

        try:
            chat = self._client.chat.create(**chat_kwargs)
            response = chat.sample()
        except Exception as exc:  # pragma: no cover - dependency failure
            raise GrokServiceError(f"Web fetch summarisation failed: {exc}") from exc

        summary = (response.content or "").strip()
        if not summary:
            summary = "No summary was produced."

        result: Dict[str, Any] = {
            "llmContent": summary,
            "returnDisplay": "Fetched content summarised.",
        }
        if first_url:
            result["sources"] = [first_url]
        if fetch_error:
            result["error"] = {"message": fetch_error}
        return result

    def ensure_correct_edit(
        self,
        *,
        filePath: str,
        currentContent: str,
        originalParams: Dict[str, Any],
        instruction: Optional[str] = None,
        max_tokens: int | None = None,
    ) -> dict:
        self._ensure_ready()
        params = dict(originalParams or {})
        occurrences = _count_occurrences(currentContent, params.get("old_string", ""))
        if occurrences:
            return {"params": params, "occurrences": occurrences}

        payload = {
            "filePath": filePath,
            "currentContentTail": currentContent[-4000:],
            "originalParams": params,
            "instruction": instruction or "",
        }

        chat_kwargs: Dict[str, Any] = {
            "model": self._config.get("model", DEFAULT_MODEL),
            "messages": [
                self._message_builder("system")(
                    "You correct failing code edit operations. Return JSON with old_string, new_string, explanation."
                ),
                self._message_builder("user")(json.dumps(payload, ensure_ascii=False)),
            ],
        }
        if max_tokens is not None:
            chat_kwargs["max_tokens"] = max_tokens

        try:
            chat = self._client.chat.create(**chat_kwargs)
            response = chat.sample()
            data = json.loads(response.content)
        except Exception:
            data = None

        if isinstance(data, dict):
            new_old = data.get("old_string")
            new_new = data.get("new_string")
            if isinstance(new_old, str) and isinstance(new_new, str):
                params["old_string"] = new_old
                params["new_string"] = new_new
                occurrences = _count_occurrences(currentContent, new_old)

        return {"params": params, "occurrences": occurrences}

    def ensure_correct_file_content(
        self,
        *,
        content: str,
        max_tokens: int | None = None,
    ) -> dict:
        self._ensure_ready()
        snippet = content[:8000]
        if not snippet.strip():
            return {"content": content}

        chat_kwargs: Dict[str, Any] = {
            "model": self._config.get("model", DEFAULT_MODEL),
            "messages": [
                self._message_builder("system")(
                    "Normalise the provided file content, fixing whitespace or newline issues. "
                    "Return the corrected file exactly."
                ),
                self._message_builder("user")(snippet),
            ],
        }
        if max_tokens is not None:
            chat_kwargs["max_tokens"] = max_tokens

        try:
            chat = self._client.chat.create(**chat_kwargs)
            response = chat.sample()
            normalised = response.content or content
        except Exception:
            normalised = content

        if not normalised:
            normalised = content
        return {"content": normalised}

    def fix_edit_with_instruction(
        self,
        *,
        instruction: str,
        oldString: str,
        newString: str,
        error: Optional[str] = None,
        currentContent: Optional[str] = None,
        max_tokens: int | None = None,
    ) -> dict:
        self._ensure_ready()
        fallback = {
            "search": oldString,
            "replace": newString,
            "noChangesRequired": False,
            "explanation": "Unable to adjust edit parameters automatically.",
        }

        payload = {
            "instruction": instruction,
            "oldString": oldString,
            "newString": newString,
            "error": error or "",
            "currentContentTail": (currentContent or "")[-4000:],
        }

        chat_kwargs: Dict[str, Any] = {
            "model": self._config.get("model", DEFAULT_MODEL),
            "messages": [
                self._message_builder("system")(
                    "You repair failed search-and-replace operations. Return JSON with search, replace, noChangesRequired, explanation."
                ),
                self._message_builder("user")(json.dumps(payload, ensure_ascii=False)),
            ],
        }
        if max_tokens is not None:
            chat_kwargs["max_tokens"] = max_tokens

        try:
            chat = self._client.chat.create(**chat_kwargs)
            response = chat.sample()
            data = json.loads(response.content)
        except Exception:
            data = None

        if isinstance(data, dict):
            search_val = data.get("search")
            replace_val = data.get("replace")
            if isinstance(search_val, str) and isinstance(replace_val, str):
                explanation_val = data.get("explanation")
                no_changes = bool(data.get("noChangesRequired"))
                fallback = {
                    "search": search_val,
                    "replace": replace_val,
                    "noChangesRequired": no_changes,
                    "explanation": explanation_val
                    if isinstance(explanation_val, str)
                    else fallback["explanation"],
                }

        return fallback

    def summarize_text(
        self,
        *,
        text: str,
        max_output_tokens: int | None = 2000,
    ) -> dict:
        self._ensure_ready()
        snippet = text[:8000]
        if not snippet.strip():
            return {"summary": ""}

        chat_kwargs: Dict[str, Any] = {
            "model": self._config.get("model", DEFAULT_MODEL),
            "messages": [
                self._message_builder("system")(
                    "Provide a concise summary of the given text. Focus on key actions and decisions."
                ),
                self._message_builder("user")(snippet),
            ],
        }
        if max_output_tokens is not None:
            chat_kwargs["max_tokens"] = max_output_tokens

        try:
            chat = self._client.chat.create(**chat_kwargs)
            response = chat.sample()
            summary = (response.content or "").strip()
        except Exception:
            summary = snippet[:500]

        return {"summary": summary}

    # ------------------------------------------------------------------
    # Uploads / collections
    # ------------------------------------------------------------------
    def upload(
        self,
        *,
        path: str,
        collection_id: str | None = None,
        mime_type: str | None = None,
    ) -> dict:
        self._ensure_ready()
        if not collection_id:
            raise GrokServiceError("collectionId is required for Grok uploads")

        file_path = Path(path)
        if not file_path.is_file():
            raise GrokServiceError(f"Upload path does not exist: {path}")

        if not hasattr(self._client, "collections"):
            raise GrokServiceError("Grok SDK collections support is unavailable")

        content_type = (
            mime_type
            or mimetypes.guess_type(file_path.name)[0]
            or "application/octet-stream"
        )

        try:
            metadata = self._client.collections.upload_document(
                collection_id=collection_id,
                name=file_path.name,
                data=file_path.read_bytes(),
                content_type=content_type,
            )
        except Exception as exc:  # pragma: no cover - defensive
            raise GrokServiceError(f"Failed to upload document to Grok: {exc}") from exc

        return MessageToDict(metadata, preserving_proto_field_name=True)

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------
    def _ensure_ready(self) -> None:
        if not self._initialised:
            raise GrokServiceError("Grok service has not been initialised yet")
        if self._client is None:
            raise GrokServiceError("Grok SDK client is not available")

    def submit_tool_result(
        self,
        call_id: str,
        content: List[dict],
        *,
        is_error: bool = False,
    ) -> None:
        with self._pending_lock:
            pending = self._pending_tool_calls.get(call_id)
        if not pending:
            raise GrokServiceError(f"Unknown tool call id: {call_id}")
        pending.content = self._normalise_tool_content(content)
        pending.is_error = is_error
        pending.event.set()

    def _default_client_factory(self, **kwargs: Any) -> Any:
        if _XAI_IMPORT_ERROR is not None:
            raise GrokServiceError(
                "xai-sdk is not installed. Install it with 'pip install xai-sdk'."
            ) from _XAI_IMPORT_ERROR
        api_key = kwargs.get("api_key")
        if api_key and not os.getenv("XAI_API_KEY"):
            os.environ.setdefault("XAI_API_KEY", api_key)
        return _XaiClient(**kwargs)

    def _build_tool_proto(self, tool: ToolDefinition) -> Any:
        schema = tool.schema if isinstance(tool.schema, dict) else {}
        try:
            return _chat_tool(tool.name, tool.description or "", schema)
        except Exception as exc:  # pragma: no cover - defensive
            raise GrokServiceError(f"Failed to register tool '{tool.name}': {exc}") from exc

    def _message_builder(self, role: str) -> Callable[..., Any]:
        builders = {
            "system": _chat_system,
            "user": _chat_user,
            "assistant": _chat_assistant,
            "model": _chat_assistant,
            "tool": _chat_tool_result,
        }
        return builders.get(role, _chat_user)

    def _render_segment(self, segment: Any) -> str:
        if isinstance(segment, dict):
            kind = segment.get("type")
            if kind == "text":
                return str(segment.get("text", ""))
            if kind == "functionCall":
                payload = segment.get("functionCall", {})
                return json.dumps({"functionCall": payload}, ensure_ascii=False)
            if kind == "functionResponse":
                payload = segment.get("functionResponse", {})
                return json.dumps({"functionResponse": payload}, ensure_ascii=False)
            return json.dumps(segment, ensure_ascii=False)
        if segment is None:
            return ""
        return str(segment)

    def _to_sdk_messages(self, messages: Iterable[dict]) -> List[Any]:
        sdk_messages: List[Any] = []
        for message in messages:
            role = str(message.get("role", "user"))
            builder = self._message_builder(role)
            content_items = message.get("content") or []

            if builder is _chat_tool_result:
                rendered = [self._render_segment(item) for item in content_items]
                text = "\n".join(filter(None, rendered)).strip()
                sdk_messages.append(builder(text))
                continue

            rendered = [self._render_segment(item) for item in content_items]
            sdk_messages.append(builder(*rendered))
        return sdk_messages

    def _translate_generation_options(self, options: Optional[dict]) -> Dict[str, Any]:
        if not options:
            return {}

        generation = options.get("generationConfig") if isinstance(options, dict) else None
        source = generation if isinstance(generation, dict) else options

        translated: Dict[str, Any] = {}
        temp = source.get("temperature") if isinstance(source, dict) else None
        if isinstance(temp, (int, float)):
            translated["temperature"] = float(temp)

        max_tokens = source.get("maxOutputTokens") if isinstance(source, dict) else None
        if isinstance(max_tokens, int):
            translated["max_tokens"] = max_tokens

        top_p = source.get("topP") if isinstance(source, dict) else None
        if isinstance(top_p, (int, float)):
            translated["top_p"] = float(top_p)

        stop_sequences = source.get("stopSequences") if isinstance(source, dict) else None
        if isinstance(stop_sequences, list):
            translated["stop"] = [str(seq) for seq in stop_sequences]

        conversation_id = source.get("conversationId") if isinstance(source, dict) else None
        if conversation_id:
            translated["conversation_id"] = str(conversation_id)

        return translated

    def _register_pending_tool_call(
        self,
        call_id: str,
        name: str,
    ) -> _PendingToolCall:
        pending = _PendingToolCall(call_id=call_id, name=name)
        with self._pending_lock:
            self._pending_tool_calls[call_id] = pending
        return pending

    def _wait_for_tool_result(
        self, pending: _PendingToolCall
    ) -> tuple[List[dict], bool]:
        pending.event.wait()
        if pending.content is None:
            raise GrokServiceError(
                f"Tool result for call {pending.call_id} did not include content",
            )
        return pending.content, pending.is_error

    def _unregister_pending_tool_call(self, call_id: str) -> None:
        with self._pending_lock:
            self._pending_tool_calls.pop(call_id, None)

    def _normalise_tool_content(self, content: List[dict]) -> List[dict]:
        normalised: List[dict] = []
        for item in content:
            if isinstance(item, dict):
                normalised.append(item)
            else:
                normalised.append({"type": "text", "text": str(item)})
        return normalised

    def _format_tool_result_content(self, content: List[dict]) -> str:
        parts: List[str] = []
        for item in content:
            item_type = item.get("type") if isinstance(item, dict) else None
            if item_type == "text":
                text_val = str(item.get("text", ""))
                if text_val:
                    parts.append(text_val)
            else:
                parts.append(json.dumps(item, ensure_ascii=False))
        return "\n".join(part for part in parts if part).strip()

    def _normalize_model(self, model: Optional[str]) -> Optional[str]:
        if not model:
            return None
        trimmed = model.strip()
        if not trimmed:
            return None
        lower = trimmed.lower()
        if lower == "auto":
            return DEFAULT_MODEL
        if lower in {
            "grok-beta",
            "grok 1.5",
            "grok-1.5",
            "grok1.5",
            "grok_v1.5",
        }:
            return DEFAULT_MODEL
        if not lower.startswith("grok"):
            return trimmed
        return trimmed

    def _select_model(self, preferred: Optional[str]) -> str:
        candidate = self._normalize_model(preferred)
        if candidate:
            return candidate

        env_candidate = self._normalize_model(
            os.environ.get("GROK_MODEL") or os.environ.get("GROK_MODEL_ID")
        )
        if env_candidate:
            return env_candidate

        return DEFAULT_MODEL


__all__ = [
    "ChatEvent",
    "ChatResult",
    "GrokService",
    "GrokServiceError",
    "ToolDefinition",
]
