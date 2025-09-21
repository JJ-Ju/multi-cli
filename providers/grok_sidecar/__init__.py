"""Grok provider sidecar package.

This module exposes the JSON-over-stdio runner that allows the Gemini CLI to
communicate with the official xAI Grok SDK without re-implementing its
functionality in TypeScript.

The entry point lives in :mod:`grok_sidecar.__main__` so the process can be
started with ``python -m grok_sidecar``.
"""

from __future__ import annotations

__all__ = ["__version__"]

__version__ = "0.1.0"

