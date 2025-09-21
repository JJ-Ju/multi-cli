"""Minimal stub implementation of the xAI SDK for smoke testing."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, Iterable, List

from . import chat


@dataclass
class _CollectionsStub:
    uploads: List[Dict[str, Any]] | None = None

    def upload_document(
        self,
        *,
        collection_id: str,
        name: str,
        data: bytes,
        content_type: str,
    ) -> Dict[str, Any]:
        if self.uploads is None:
            self.uploads = []
        record = {
            "collection_id": collection_id,
            "name": name,
            "data": data,
            "content_type": content_type,
        }
        self.uploads.append(record)
        return {
            "file_metadata": {
                "file_id": "stub-doc-1",
                "name": name,
                "content_type": content_type,
            }
        }


class _ChatSession:
    def __init__(self, **_: Any) -> None:
        self._appended_messages: List[dict] = []

    def sample(self) -> chat.Response:
        return chat.Response("Yes, I am grok.")

    def stream(self) -> Iterable[tuple[chat.Response, chat.Chunk]]:
        text = "[grok-stub] hello"
        yield chat.Response(text), chat.Chunk(text)

    def append(self, message: dict) -> "_ChatSession":
        self._appended_messages.append(message)
        return self


class _ChatAPI:
    def __init__(self) -> None:
        self.created_payloads: List[Dict[str, Any]] = []

    def create(self, **kwargs: Any) -> _ChatSession:
        self.created_payloads.append(kwargs)
        return _ChatSession(**kwargs)


class Client:
    def __init__(self, **_: Any) -> None:
        self.chat = _ChatAPI()
        self.collections = _CollectionsStub()


__all__ = ["Client", "chat"]
