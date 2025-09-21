/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { GenerateContentParameters, Part } from '@google/genai';

import { GrokContentGenerator } from './grokContentGenerator.js';
import type { GrokSidecarClient } from './grokSidecarClient.js';

const createConfigMock = () =>
  ({
    getSessionId: () => 'session-123',
    getProxy: () => undefined,
  }) as unknown as import('../config/config.js').Config;

describe('GrokContentGenerator', () => {
  it('emits stream chunks for delta and toolCall events', async () => {
    const eventStream = new EventEmitter();
    const resultPayload = {
      message: {
        content: [
          {
            type: 'text',
            text: 'Final response',
          },
        ],
      },
      usage: {
        totalTokens: 12,
      },
    } satisfies {
      message: Record<string, unknown>;
      usage?: Record<string, unknown>;
    };

    const sidecar = {
      ensureInitialised: vi.fn().mockResolvedValue(undefined),
      registerTools: vi.fn().mockResolvedValue(undefined),
      chatStream: vi.fn().mockReturnValue({
        stream: eventStream,
        result: Promise.resolve(resultPayload),
      }),
    } as unknown as GrokSidecarClient;

    const generator = new GrokContentGenerator(createConfigMock(), sidecar, {
      apiKey: 'key',
    });

    const request = {
      contents: [],
      config: {},
    } as unknown as GenerateContentParameters;

    const stream = await generator.generateContentStream(request, 'prompt-1');

    const chunksPromise = (async () => {
      const collected: unknown[] = [];
      for await (const chunk of stream) {
        collected.push(chunk);
        if (collected.length === 3) {
          break;
        }
      }
      return collected;
    })();

    // Emit events asynchronously to ensure the stream is already listening.
    setImmediate(() => {
      eventStream.emit('event', { event: 'delta', text: 'Hello ' });
      eventStream.emit('event', {
        event: 'toolCall',
        callId: 'call-1',
        name: 'search_code',
        arguments: '{"query":"foo"}',
      });
      eventStream.emit('end');
    });

    const chunks = (await chunksPromise) as Array<Record<string, unknown>>;
    expect(chunks).toHaveLength(3);

    expect(chunks[0]).toMatchObject({
      candidates: [
        {
          content: {
            parts: [
              {
                text: 'Hello ',
              },
            ],
          },
        },
      ],
    });

    expect(chunks[1]).toMatchObject({
      candidates: [
        {
          content: {
            parts: [
              {
                functionCall: {
                  id: 'call-1',
                  name: 'search_code',
                  args: { query: 'foo' },
                },
              },
            ],
          },
        },
      ],
    });

    expect(chunks[2]).toMatchObject({
      candidates: [
        {
          content: {
            parts: [
              expect.objectContaining({
                text: expect.stringContaining('Final response'),
              }),
            ],
          },
        },
      ],
    });

    const usageMetadata = (chunks[2] as Record<string, unknown>)[
      'usageMetadata'
    ];
    expect(usageMetadata as Record<string, unknown>).toMatchObject({
      totalTokenCount: resultPayload.usage?.totalTokens,
    });

    expect(sidecar.ensureInitialised).toHaveBeenCalled();
    expect(sidecar.registerTools).not.toHaveBeenCalled();
  });

  it('converts functionResponse messages into tool role payloads', async () => {
    const sidecar = {
      ensureInitialised: vi.fn().mockResolvedValue(undefined),
      registerTools: vi.fn().mockResolvedValue(undefined),
      chatStream: vi.fn().mockReturnValue({
        stream: new EventEmitter(),
        result: Promise.resolve({
          message: { content: [] },
        }),
      }),
    } as unknown as GrokSidecarClient;

    const generator = new GrokContentGenerator(createConfigMock(), sidecar, {
      apiKey: 'key',
    });

    const request = {
      contents: [
        {
          role: 'user',
          parts: [
            {
              functionResponse: {
                id: 'call-1',
                name: 'search_code',
                response: { output: 'tool output' },
              },
            },
          ],
        },
      ],
      config: {},
    } as unknown as GenerateContentParameters;

    await generator.generateContentStream(request, 'prompt-1');

    expect(sidecar.chatStream).toHaveBeenCalledTimes(1);
    const payload = vi.mocked(sidecar.chatStream).mock
      .calls[0]?.[0] as unknown as
      | {
          messages: Array<{ role: string; content?: Array<{ text?: string }> }>;
        }
      | undefined;
    expect(payload).toBeDefined();
    const lastMessage = payload!.messages[payload!.messages.length - 1];
    expect(lastMessage['role']).toBe('tool');
    const firstContent = Array.isArray(lastMessage['content'])
      ? lastMessage['content'][0]
      : undefined;
    const toolText = String(firstContent?.['text'] ?? '');
    expect(toolText).toContain('tool output');
    expect(toolText).toContain('call-1');
  });

  it('submits tool results via the sidecar when supported', async () => {
    const toolResultMock = vi.fn().mockResolvedValue(undefined);
    const sidecar = {
      ensureInitialised: vi.fn().mockResolvedValue(undefined),
      registerTools: vi.fn().mockResolvedValue(undefined),
      chatStream: vi.fn().mockReturnValue({
        stream: new EventEmitter(),
        result: Promise.resolve({
          message: { content: [] },
        }),
      }),
      toolResult: toolResultMock,
    } as unknown as GrokSidecarClient;

    const generator = new GrokContentGenerator(createConfigMock(), sidecar, {
      apiKey: 'key',
    });

    const parts = [{ text: 'tool text' }] as unknown as Part[];
    const submitted = await generator.submitToolResult('call-1', parts, false);

    expect(submitted).toBe(true);
    expect(toolResultMock).toHaveBeenCalledWith(
      'call-1',
      [{ text: 'tool text' }],
      false,
    );
  });
});
