from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
import sys
from unittest import mock

_PACKAGE_ROOT = Path(__file__).resolve().parent.parent
if str(_PACKAGE_ROOT) not in sys.path:
    sys.path.insert(0, str(_PACKAGE_ROOT))

from google.protobuf.json_format import MessageToDict

from grok_sidecar.service import (
    ChatEvent,
    GrokService,
    GrokServiceError,
    ToolDefinition,
)

from xai_sdk.chat import Chunk, Response, chat_pb2, usage_pb2
from xai_sdk.collections import collections_pb2


def _make_response(
    text: str,
    total_tokens: int = 5,
    *,
    citations: list[str] | None = None,
) -> Response:
    response_pb = chat_pb2.GetChatCompletionResponse(
        id="resp-1",
        model="grok-beta",
        usage=usage_pb2.SamplingUsage(total_tokens=total_tokens, completion_tokens=total_tokens),
        choices=[
            chat_pb2.Choice(
                index=0,
                message=chat_pb2.CompletionMessage(
                    role=chat_pb2.MessageRole.ROLE_ASSISTANT,
                    content=text,
                ),
            )
        ],
    )
    if citations:
        response_pb.citations.extend(citations)
    return Response(response_pb, 0)


def _make_chunk(text: str) -> Chunk:
    chunk_pb = chat_pb2.GetChatCompletionChunk(
        choices=[
            chat_pb2.ChoiceChunk(
                index=0,
                delta=chat_pb2.Delta(
                    role=chat_pb2.MessageRole.ROLE_ASSISTANT,
                    content=text,
                ),
            )
        ],
    )
    return Chunk(chunk_pb, 0)


class _QueuedChatAPI:
    def __init__(self) -> None:
        self._queue: list[object] = []
        self.created_payloads: list[dict] = []

    def queue(self, chat_obj: object) -> None:
        self._queue.append(chat_obj)

    def create(self, **kwargs) -> object:
        self.created_payloads.append(kwargs)
        if not self._queue:
            raise AssertionError("No queued chat instances available")
        return self._queue.pop(0)


class _ValidateChat:
    def __init__(self, response: Response) -> None:
        self._response = response

    def sample(self) -> Response:
        return self._response


class _StreamingChat:
    def __init__(self, stream_items: list[tuple[Response, Chunk]]) -> None:
        self._stream_items = stream_items

    def stream(self):
        for item in self._stream_items:
            yield item


class _ToolCallChat:
    def __init__(self, response_after_tool: str = 'Final reply') -> None:
        self._phase = 0
        self._final_response = response_after_tool

    def stream(self):
        if self._phase == 0:
            self._phase = 1
            chunk_pb = chat_pb2.GetChatCompletionChunk(
                choices=[
                    chat_pb2.ChoiceChunk(
                        index=0,
                        delta=chat_pb2.Delta(
                            tool_calls=[
                                chat_pb2.ToolCall(
                                    id='call-1',
                                    function=chat_pb2.FunctionCall(
                                        name='search_code',
                                        arguments='{"query":"foo"}',
                                    ),
                                )
                            ],
                        ),
                    )
                ],
            )
            yield _make_response(''), Chunk(chunk_pb, 0)
        elif self._phase == 1:
            self._phase = 2
            chunk_pb = chat_pb2.GetChatCompletionChunk(
                choices=[
                    chat_pb2.ChoiceChunk(
                        index=0,
                        delta=chat_pb2.Delta(
                            content=self._final_response,
                        ),
                    )
                ],
            )
            yield _make_response(self._final_response), Chunk(chunk_pb, 0)

    def append(self, _message) -> "_ToolCallChat":
        return self


class _CollectionsStub:
    def __init__(self) -> None:
        self.upload_calls: list[dict] = []

    def upload_document(self, *, collection_id: str, name: str, data: bytes, content_type: str):
        self.upload_calls.append(
            {
                "collection_id": collection_id,
                "name": name,
                "data": data,
                "content_type": content_type,
            }
        )
        return collections_pb2.DocumentMetadata(
            file_metadata=collections_pb2.FileMetadata(
                file_id="doc-1",
                name=name,
                content_type=content_type,
            )
        )


class _ClientStub:
    def __init__(self) -> None:
        self.chat = _QueuedChatAPI()
        self.collections = _CollectionsStub()


class GrokServiceTest(unittest.TestCase):
    def test_initialise_requires_api_key(self) -> None:
        service = GrokService(client_factory=lambda **_: _ClientStub())
        with self.assertRaises(GrokServiceError):
            service.initialise(api_key="")

    def test_initialise_uses_client_factory(self) -> None:
        client = _ClientStub()
        service = GrokService(client_factory=lambda **kwargs: client)
        result = service.initialise(api_key="secret", model="grok-beta")

        self.assertTrue(service._initialised)  # type: ignore[attr-defined]
        self.assertIn("capabilities", result)
        self.assertTrue(result["capabilities"]["supportsCollections"])

    def test_validate_streams_response(self) -> None:
        client = _ClientStub()
        client.chat.queue(_ValidateChat(_make_response("Yes, I am Grok.")))
        service = GrokService(client_factory=lambda **_: client)
        service.initialise(api_key="secret")

        events, result = service.validate("are you grok?")

        self.assertEqual(len(events), 1)
        self.assertEqual(events[0].payload["text"], "Yes, I am Grok.")
        self.assertTrue(result["passed"])

    def test_chat_stream_updates_result(self) -> None:
        client = _ClientStub()
        stream_items = [
            (_make_response("Hello world"), _make_chunk("Hello ")),
            (_make_response("Hello world"), _make_chunk("world")),
        ]
        client.chat.queue(_StreamingChat(stream_items))

        service = GrokService(client_factory=lambda **_: client)
        service.initialise(api_key="secret")

        events, result = service.chat(
            messages=[{"role": "user", "content": [{"type": "text", "text": "Hi"}]}],
            tools=[],
            options={},
        )

        deltas = [event.payload["text"] for event in list(events)]
        self.assertEqual(deltas, ["Hello ", "world"])
        self.assertEqual(result.message["content"][0]["text"], "Hello world")
        self.assertIsNotNone(result.usage)
        usage_dict = result.usage or {}
        self.assertEqual(usage_dict.get("total_tokens"), 5)

    def test_upload_reads_file_and_returns_metadata(self) -> None:
        client = _ClientStub()
        service = GrokService(client_factory=lambda **_: client)
        service.initialise(api_key="secret")

        with tempfile.NamedTemporaryFile(delete=False) as handle:
            handle.write(b"sample")
            temp_path = Path(handle.name)

        try:
            metadata = service.upload(
                path=str(temp_path),
                collection_id="collection-1",
                mime_type="text/plain",
            )
        finally:
            temp_path.unlink(missing_ok=True)

        file_meta = metadata.get("file_metadata", {})
        self.assertEqual(file_meta.get("name"), temp_path.name)
        self.assertEqual(client.collections.upload_calls[0]["content_type"], "text/plain")

    def test_chat_emits_tool_call_event(self) -> None:
        client = _ClientStub()
        tool_chat = _ToolCallChat()
        client.chat.queue(tool_chat)

        service = GrokService(client_factory=lambda **_: client)
        service.initialise(api_key="secret")

        events_iter, result = service.chat(
            messages=[{"role": "user", "content": [{"type": "text", "text": "Hi"}]}],
            tools=[],
            options={},
        )

        tool_event = next(events_iter)
        self.assertEqual(tool_event.event, "toolCall")
        self.assertEqual(tool_event.payload["name"], "search_code")
        call_id = tool_event.payload["callId"]

        service.submit_tool_result(
            call_id,
            [{"type": "text", "text": "Result from tool"}],
            is_error=False,
        )

        final_event = next(events_iter, None)
        self.assertIsNotNone(final_event)
        self.assertEqual(final_event.payload.get("text"), tool_chat._final_response)
        self.assertIsNone(next(events_iter, None))
        self.assertEqual(
            result.message["content"][0]["text"],
            tool_chat._final_response,
        )

    def test_web_search_returns_result(self) -> None:
        client = _ClientStub()
        response = _make_response(
            "Search answer",
            citations=["https://example.com"],
        )
        client.chat.queue(_ValidateChat(response))

        service = GrokService(client_factory=lambda **_: client)
        service.initialise(api_key="secret")

        result = service.web_search(query="latest news")

        self.assertIn("Search answer", result["llmContent"])
        self.assertEqual(result["sources"], ["https://example.com"])

    @mock.patch('grok_sidecar.service.urllib_request.urlopen')
    def test_web_fetch_fetches_and_summarises(self, mock_urlopen: mock.MagicMock) -> None:
        client = _ClientStub()
        client.chat.queue(_ValidateChat(_make_response("Summary output")))

        service = GrokService(client_factory=lambda **_: client)
        service.initialise(api_key="secret")

        fake_handle = mock.MagicMock()
        fake_handle.__enter__.return_value = fake_handle
        fake_handle.__exit__.return_value = False
        fake_handle.read.return_value = b"<html><body>Hello</body></html>"
        fake_handle.headers.get_content_charset.return_value = 'utf-8'
        mock_urlopen.return_value = fake_handle

        result = service.web_fetch(prompt="Summarise https://example.com/article")

        self.assertIn("Summary output", result["llmContent"])
        self.assertEqual(result["sources"], ["https://example.com/article"])
        mock_urlopen.assert_called_once()

    def test_ensure_correct_edit_uses_llm_suggestion(self) -> None:
        client = _ClientStub()
        client.chat.queue(
            _ValidateChat(
                _make_response('{"old_string":"foo","new_string":"bar"}')
            )
        )

        service = GrokService(client_factory=lambda **_: client)
        service.initialise(api_key="secret")

        result = service.ensure_correct_edit(
            filePath="test.py",
            currentContent="foo foo foo",
            originalParams={
                "file_path": "test.py",
                "old_string": "baz",
                "new_string": "qux",
            },
            instruction="",
        )

        self.assertEqual(result["params"]["old_string"], "foo")
        self.assertEqual(result["params"]["new_string"], "bar")
        self.assertEqual(result["occurrences"], 3)

    def test_summarize_text_returns_summary(self) -> None:
        client = _ClientStub()
        client.chat.queue(_ValidateChat(_make_response("short summary")))

        service = GrokService(client_factory=lambda **_: client)
        service.initialise(api_key="secret")

        result = service.summarize_text(text="long text", max_output_tokens=128)

        self.assertEqual(result["summary"], "short summary")


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
