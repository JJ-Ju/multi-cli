"""Minimal stub of xAI chat helpers for Grok smoke tests."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Iterable, List, Optional


@dataclass
class Choice:
    content: str
    tool_calls: Optional[List[dict]] = None


class Chunk:
    def __init__(self, content: str, tool_calls: Optional[List[dict]] = None):
        self.choices = [Choice(content=content, tool_calls=tool_calls or [])]


class Response:
    def __init__(self, content: str = ""):
        self.content = content
        self.usage = None


def assistant(*segments: Iterable[Any]) -> dict:
    return {"role": "assistant", "content": list(segments)}


def system(*segments: Iterable[Any]) -> dict:
    return {"role": "system", "content": list(segments)}


def user(*segments: Iterable[Any]) -> dict:
    return {"role": "user", "content": list(segments)}


def tool(name: str, description: str, schema: dict) -> dict:
    return {"name": name, "description": description, "schema": schema}


def tool_result(text: str) -> dict:
    return {"role": "tool", "content": [{"type": "text", "text": text}]}


__all__ = [
    "Chunk",
    "Response",
    "assistant",
    "system",
    "user",
    "tool",
    "tool_result",
]
