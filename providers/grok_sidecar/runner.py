"""Runtime wiring for the Grok sidecar process."""

from __future__ import annotations

import json
import logging
import sys
from typing import IO, Any
import threading

from .service import (
    ChatEvent,
    GrokService,
    GrokServiceError,
    ToolDefinition,
)


LOGGER = logging.getLogger(__name__)


class SidecarRunner:
    """Main loop that mediates between stdin/stdout and the Grok service."""

    def __init__(
        self,
        *,
        input_stream: IO[str] | None = None,
        output_stream: IO[str] | None = None,
    ) -> None:
        self._input = input_stream or sys.stdin
        self._output = output_stream or sys.stdout
        self._service = GrokService()
        self._running = False
        self._send_lock = threading.Lock()
        self._chat_threads: set[threading.Thread] = set()

    # ------------------------------------------------------------------
    def run(self) -> None:
        self._running = True
        for raw_line in self._input:
            if not self._running:
                break
            line = raw_line.strip()
            if not line:
                continue
            LOGGER.debug("<- %s", line)
            try:
                message = json.loads(line)
            except json.JSONDecodeError as exc:
                LOGGER.warning("Invalid JSON payload: %s", exc)
                self._send_error(None, f"Invalid JSON: {exc}")
                continue

            if message.get("type") != "request":
                self._send_error(
                    message.get("requestId"),
                    "Expected message type 'request'",
                )
                continue

            request_id = message.get("requestId")
            action = message.get("action")
            payload = message.get("payload") or {}
            if not request_id or not action:
                self._send_error(request_id, "Missing requestId or action")
                continue

            handler_name = f"_handle_{action.replace('.', '_')}"
            try:
                handler = getattr(self, handler_name)
            except AttributeError:
                self._send_error(request_id, f"Unknown action: {action}")
                continue

            if action == "chat":
                thread = threading.Thread(
                    target=self._run_chat_handler,
                    args=(handler, request_id, payload, action),
                    daemon=True,
                )
                self._chat_threads.add(thread)
                thread.start()
                continue

            self._invoke_handler(handler, request_id, payload, action)

    def stop(self) -> None:
        self._running = False
        for thread in list(self._chat_threads):
            if thread.is_alive():
                thread.join(timeout=0.1)
            self._chat_threads.discard(thread)

    def _run_chat_handler(
        self,
        handler,
        request_id: str,
        payload: dict,
        action: str,
    ) -> None:
        try:
            self._invoke_handler(handler, request_id, payload, action)
        finally:
            self._chat_threads.discard(threading.current_thread())

    def _invoke_handler(
        self,
        handler,
        request_id: str,
        payload: dict,
        action: str,
    ) -> None:
        try:
            handler(request_id, payload)
        except GrokServiceError as exc:
            LOGGER.warning("Service error for %s: %s", action, exc)
            self._send_error(request_id, str(exc), code="SERVICE_ERROR")
        except Exception as exc:  # pragma: no cover - defensive
            LOGGER.exception("Unhandled error during %s", action)
            self._send_error(request_id, f"Unhandled exception: {exc}")

    # ------------------------------------------------------------------
    # Request handlers
    # ------------------------------------------------------------------
    def _handle_initialize(self, request_id: str, payload: dict) -> None:
        result = self._service.initialise(**payload)
        self._send_result(request_id, result)

    def _handle_registerTools(self, request_id: str, payload: dict) -> None:
        raw_tools = payload.get("tools", [])
        tools = [
            ToolDefinition(
                name=tool.get("name"),
                description=tool.get("description", ""),
                schema=tool.get("schema", {}),
            )
            for tool in raw_tools
            if tool.get("name")
        ]
        self._service.register_tools(tools)
        self._send_result(request_id, {"registered": len(tools)})

    def _handle_validate(self, request_id: str, payload: dict) -> None:
        prompt = payload.get("prompt", "")
        events, result = self._service.validate(prompt)
        self._emit_events(request_id, events)
        self._send_result(request_id, result)

    def _handle_chat(self, request_id: str, payload: dict) -> None:
        messages = payload.get("messages", [])
        tools_payload = payload.get("tools", [])
        tools = [
            ToolDefinition(
                name=tool.get("name"),
                description=tool.get("description", ""),
                schema=tool.get("schema", {}),
            )
            for tool in tools_payload
            if tool.get("name")
        ]
        options = payload.get("options") or {}

        stream, result = self._service.chat(
            messages=messages,
            tools=tools,
            options=options,
        )
        self._emit_events(request_id, stream)
        self._send_result(request_id, {
            "message": result.message,
            "usage": result.usage,
        })

    def _handle_toolResult(self, request_id: str, payload: dict) -> None:
        call_id = payload.get("callId")
        if not call_id:
            self._send_error(request_id, "Missing callId in toolResult payload")
            return

        content = payload.get("content") or []
        if not isinstance(content, list):
            self._send_error(request_id, "toolResult content must be a list")
            return

        is_error = bool(payload.get("isError"))

        try:
            self._service.submit_tool_result(call_id, content, is_error=is_error)
        except GrokServiceError as exc:
            LOGGER.warning("Service error processing toolResult: %s", exc)
            self._send_error(request_id, str(exc), code="SERVICE_ERROR")
            return
        except Exception as exc:  # pragma: no cover - defensive
            LOGGER.exception("Unhandled error processing toolResult")
            self._send_error(request_id, f"Unhandled exception: {exc}")
            return

        acknowledgement = {"callId": call_id, "acknowledged": True}
        self._send_result(request_id, acknowledgement)

    def _handle_tooling_webSearch(self, request_id: str, payload: dict) -> None:
        query = payload.get("query", "")
        options = payload.get("options") or {}
        result = self._service.web_search(query=query, **options)
        self._send_result(request_id, result)

    def _handle_tooling_webFetch(self, request_id: str, payload: dict) -> None:
        prompt = payload.get("prompt", "")
        options = payload.get("options") or {}
        result = self._service.web_fetch(prompt=prompt, **options)
        self._send_result(request_id, result)

    def _handle_tooling_ensureCorrectEdit(self, request_id: str, payload: dict) -> None:
        result = self._service.ensure_correct_edit(**payload)
        self._send_result(request_id, result)

    def _handle_tooling_ensureCorrectFileContent(
        self, request_id: str, payload: dict
    ) -> None:
        result = self._service.ensure_correct_file_content(**payload)
        self._send_result(request_id, result)

    def _handle_tooling_fixEditWithInstruction(
        self, request_id: str, payload: dict
    ) -> None:
        result = self._service.fix_edit_with_instruction(**payload)
        self._send_result(request_id, result)

    def _handle_tooling_summarizeText(self, request_id: str, payload: dict) -> None:
        result = self._service.summarize_text(**payload)
        self._send_result(request_id, result)

    def _handle_upload(self, request_id: str, payload: dict) -> None:
        result = self._service.upload(
            path=payload.get("path", ""),
            collection_id=payload.get("collectionId"),
            mime_type=payload.get("mimeType"),
        )
        self._send_result(request_id, result)

    def _handle_shutdown(self, request_id: str, _payload: dict) -> None:
        self._send_result(request_id, {"status": "shutting down"})
        self.stop()

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------
    def _emit_events(self, request_id: str, events: Any) -> None:
        for event in events:
            if isinstance(event, ChatEvent):
                payload = event.payload | {"event": event.event}
            elif isinstance(event, dict):
                payload = event
            else:
                payload = {"event": "unknown", "value": event}
            self._send({
                "type": "event",
                "requestId": request_id,
                "payload": payload,
            })

    def _send_result(self, request_id: str | None, payload: dict | None) -> None:
        self._send({
            "type": "result",
            "requestId": request_id,
            "payload": payload,
        })

    def _send_error(self, request_id: str | None, message: str, *, code: str | None = None) -> None:
        self._send({
            "type": "error",
            "requestId": request_id,
            "error": {"message": message, "code": code},
        })

    def _send(self, message: dict) -> None:
        line = json.dumps(message, separators=(",", ":"))
        LOGGER.debug("-> %s", line)
        with self._send_lock:
            print(line, file=self._output, flush=True)


__all__ = ["SidecarRunner"]
