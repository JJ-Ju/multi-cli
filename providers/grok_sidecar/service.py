"""Abstractions over the Grok SDK integration.

This module isolates all direct dependencies on the xAI Python SDK so the rest
of the sidecar can remain stable even if we swap implementations. The
implementation below wires the runtime to the official ``xai-sdk`` package and
translates between the Gemini CLI's JSON protocol and the SDK's Python objects.
"""

from __future__ import annotations

from dataclasses import dataclass, field
import json
import mimetypes
import os
import threading
import uuid
from pathlib import Path
from typing import Any, Callable, Dict, Iterable, Iterator, List, Optional

from google.protobuf.json_format import MessageToDict

try:  # pragma: no cover - exercised indirectly via service initialisation
    from xai_sdk import Client as _XaiClient
    from xai_sdk.chat import assistant as _chat_assistant
    from xai_sdk.chat import system as _chat_system
    from xai_sdk.chat import tool as _chat_tool
    from xai_sdk.chat import tool_result as _chat_tool_result
    from xai_sdk.chat import user as _chat_user
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

        self._config = {"api_key": api_key, "model": model or "grok-beta"}
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
                model=self._config.get("model"),
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
                model=self._config.get("model"),
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


__all__ = [
    "ChatEvent",
    "ChatResult",
    "GrokService",
    "GrokServiceError",
    "ToolDefinition",
]
