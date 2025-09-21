/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  CountTokensParameters,
  CountTokensResponse,
  EmbedContentParameters,
  EmbedContentResponse,
  GenerateContentParameters,
  GenerateContentResponse,
  Tool,
  Part,
  FunctionCall,
} from '@google/genai';
import { FinishReason } from '@google/genai';
import type { EventEmitter } from 'node:events';

import type { ContentGenerator } from '../core/contentGenerator.js';
import type { Config } from '../config/config.js';
import type { ChatRequestPayload } from './grokSidecarClient.js';
import type { GrokSidecarClient } from './grokSidecarClient.js';
import { logGrokDebug } from './grokDebugLogger.js';

interface GrokContentGeneratorOptions {
  apiKey: string;
  model?: string;
  pythonPath?: string;
}

type FunctionResponsePayload = {
  id?: string;
  name?: string;
  response?: Record<string, unknown> & { output?: unknown };
};

type FunctionResponsePart = {
  functionResponse: FunctionResponsePayload;
};

export class GrokContentGenerator implements ContentGenerator {
  constructor(
    private readonly config: Config,
    private readonly sidecar: GrokSidecarClient,
    private readonly options: GrokContentGeneratorOptions,
  ) {}

  async generateContent(
    request: GenerateContentParameters,
    userPromptId: string,
  ): Promise<GenerateContentResponse> {
    logGrokDebug('grok.generateContent.begin', {
      sessionId: this.config.getSessionId(),
      userPromptId,
      model: this.getConfiguredModel(),
    });

    const stream = await this.generateContentStream(request, userPromptId);
    let lastChunk: GenerateContentResponse | undefined;
    for await (const chunk of stream) {
      lastChunk = chunk;
    }
    if (!lastChunk) {
      throw new Error('Grok sidecar did not return any content.');
    }

    logGrokDebug('grok.generateContent.end', {
      sessionId: this.config.getSessionId(),
      hasContent: !!lastChunk,
    });

    return lastChunk;
  }

  generateContentStream(
    request: GenerateContentParameters,
    userPromptId: string,
  ): Promise<AsyncGenerator<GenerateContentResponse>> {
    return (async () => {
      logGrokDebug('grok.generateContentStream.begin', {
        sessionId: this.config.getSessionId(),
        userPromptId,
        model: this.getConfiguredModel(),
      });

      await this.sidecar.ensureInitialised({
        apiKey: this.options.apiKey,
        api_key: this.options.apiKey,
        model: this.options.model,
        pythonPath: this.options.pythonPath,
      });
      logGrokDebug('grok.generateContentStream.initialised');

      const { payload, toolDefinitions } = this.toChatPayload(request);
      logGrokDebug('grok.generateContentStream.payloadReady', {
        messageCount: payload.messages.length,
        toolCount: payload.tools.length,
      });

      if (toolDefinitions.length) {
        logGrokDebug('grok.generateContentStream.registerTools', {
          toolCount: toolDefinitions.length,
        });
        await this.sidecar.registerTools(toolDefinitions);
      }

      const { stream, result } = this.sidecar.chatStream(payload);
      logGrokDebug('grok.generateContentStream.chatStreamStarted', {
        sessionId: payload.sessionId,
      });

      return this.createStreamGenerator(stream, result);
    })();
  }

  async countTokens(
    _request: CountTokensParameters,
  ): Promise<CountTokensResponse> {
    // TODO: Integrate with official SDK when available.
    return { totalTokens: 0 } as CountTokensResponse;
  }

  async embedContent(
    _request: EmbedContentParameters,
  ): Promise<EmbedContentResponse> {
    throw new Error(
      'Embed content is not supported for the Grok provider yet.',
    );
  }

  async submitToolResult(
    callId: string,
    responseParts: Part[],
    isError: boolean,
  ): Promise<boolean> {
    const serializable = responseParts.map((part) =>
      JSON.parse(JSON.stringify(part ?? {})),
    );
    logGrokDebug('grok.submitToolResult', {
      callId,
      partCount: serializable.length,
      isError,
    });
    await this.sidecar.toolResult(callId, serializable, isError);
    return true;
  }

  private toChatPayload(request: GenerateContentParameters): {
    payload: ChatRequestPayload;
    toolDefinitions: Array<Record<string, unknown>>;
  } {
    const contents = Array.isArray(request.contents) ? request.contents : [];
    const messages: Array<{ role: string; content: unknown[] }> = [];

    for (const item of contents) {
      if (typeof item === 'string') {
        messages.push({
          role: 'user',
          content: [{ type: 'text', text: item }],
        });
        continue;
      }
      if (typeof item !== 'object' || item === null || !('role' in item)) {
        continue;
      }

      const content = item as { role: string; parts?: unknown };
      const role = content.role === 'model' ? 'assistant' : content.role;
      const partsArray = Array.isArray(content.parts) ? content.parts : [];

      const normalisedParts: unknown[] = [];
      let functionResponseAggregated = false;
      const toolContentSegments: string[] = [];
      let toolCallId: string | undefined;
      let toolName: string | undefined;

      for (const part of partsArray) {
        if (typeof part !== 'object' || part === null) {
          normalisedParts.push({ type: 'text', text: String(part) });
          continue;
        }

        if (
          'text' in part &&
          typeof (part as { text?: unknown }).text === 'string'
        ) {
          const textValue = (part as { text: string }).text;
          if (functionResponseAggregated) {
            toolContentSegments.push(textValue);
          } else {
            normalisedParts.push({ type: 'text', text: textValue });
          }
          continue;
        }

        if ('functionCall' in part) {
          normalisedParts.push({
            type: 'functionCall',
            functionCall: (part as { functionCall: FunctionCall }).functionCall,
          });
          continue;
        }

        if ('functionResponse' in part) {
          const response = (part as FunctionResponsePart).functionResponse;
          functionResponseAggregated = true;
          toolCallId = response?.id ?? toolCallId;
          toolName = response?.name ?? toolName;
          const output = response?.response?.output;
          if (typeof output === 'string' && output.trim()) {
            toolContentSegments.push(output.trim());
          } else if (
            response !== undefined &&
            response !== null &&
            typeof response.response !== 'undefined'
          ) {
            toolContentSegments.push(JSON.stringify(response.response));
          }
          continue;
        }

        toolContentSegments.push(JSON.stringify(part));
      }

      if (functionResponseAggregated) {
        const text = toolContentSegments.join('\n').trim();
        const resolvedText = text || 'Tool execution succeeded.';
        const headerParts: string[] = [];
        if (toolName) {
          headerParts.push(`tool: ${toolName}`);
        }
        if (toolCallId) {
          headerParts.push(`callId: ${toolCallId}`);
        }
        const header = headerParts.length
          ? `[${headerParts.join(' ')}]`
          : undefined;
        const finalText = header ? `${header}\n${resolvedText}` : resolvedText;
        messages.push({
          role: 'tool',
          content: [{ type: 'text', text: finalText }],
        });
        continue;
      }

      messages.push({ role, content: normalisedParts });
    }

    const configTools = (request as { config?: { tools?: Tool[] } }).config
      ?.tools;
    const toolDefs = this.extractToolDefinitions(configTools ?? []);

    return {
      payload: {
        sessionId: this.config.getSessionId(),
        messages,
        tools: toolDefs,
        options: request.config ? { generationConfig: request.config } : {},
      },
      toolDefinitions: toolDefs,
    };
  }

  private extractToolDefinitions(
    tools: Tool[],
  ): Array<Record<string, unknown>> {
    const defs: Array<Record<string, unknown>> = [];
    for (const tool of tools) {
      for (const declaration of tool.functionDeclarations ?? []) {
        defs.push({
          name: declaration.name,
          description: declaration.description,
          schema: declaration.parametersJsonSchema,
        });
      }
    }
    return defs;
  }

  private static toGenerateContentResponse(response: {
    message: Record<string, unknown>;
    usage?: Record<string, unknown>;
  }): GenerateContentResponse {
    const content = (response.message?.['content'] as unknown[]) || [];
    const textParts = content
      .filter((part) => typeof part === 'object' && part !== null)
      .map((part) => {
        const candidate = part as { type?: string; text?: string };
        if (candidate.type === 'text' || typeof candidate.text === 'string') {
          return { text: candidate.text ?? '' };
        }
        return { text: JSON.stringify(candidate) };
      });
    if (textParts.length === 0) {
      textParts.push({ text: '' });
    }

    const generateResponse = {
      candidates: [
        {
          content: {
            role: 'model',
            parts: textParts,
          },
          finishReason: FinishReason.STOP,
        },
      ],
      usageMetadata: response.usage,
    };

    return generateResponse as unknown as GenerateContentResponse;
  }

  private createStreamGenerator(
    eventStream: EventEmitter,
    resultPromise: Promise<{
      message: Record<string, unknown>;
      usage?: Record<string, unknown>;
    }>,
  ): AsyncGenerator<GenerateContentResponse> {
    const queue: Array<Record<string, unknown>> = [];
    let ended = false;
    let pendingResolve: (() => void) | null = null;
    let errorFromStream: Error | null = null;

    const onEvent = (payload: Record<string, unknown>) => {
      logGrokDebug('grok.stream.event', {
        event: payload?.['event'],
        hasText: typeof payload?.['text'] === 'string',
      });
      queue.push(payload);
      if (pendingResolve) {
        pendingResolve();
        pendingResolve = null;
      }
    };

    const onEnd = () => {
      ended = true;
      logGrokDebug('grok.stream.end');
      if (pendingResolve) {
        pendingResolve();
        pendingResolve = null;
      }
    };

    const onError = (error: Error) => {
      errorFromStream = error;
      ended = true;
      logGrokDebug('grok.stream.error', { message: error.message });
      if (pendingResolve) {
        pendingResolve();
        pendingResolve = null;
      }
    };

    eventStream.on('event', onEvent);
    eventStream.on('end', onEnd);
    eventStream.on('error', onError);

    const waitForNext = () =>
      new Promise<void>((resolve) => {
        if (queue.length || ended) {
          resolve();
        } else {
          pendingResolve = resolve;
        }
      });

    const generator = async function* (this: GrokContentGenerator) {
      try {
        while (true) {
          if (!queue.length) {
            await waitForNext();
            if (errorFromStream) {
              logGrokDebug('grok.stream.generator.error', {
                message: errorFromStream.message,
              });
              throw errorFromStream;
            }
            if (!queue.length && ended) {
              break;
            }
          }

          if (!queue.length) {
            continue;
          }

          const payload = queue.shift();
          if (!payload) {
            continue;
          }

          const eventType = String(payload['event'] ?? '');
          if (eventType === 'delta') {
            const text = String(payload['text'] ?? '');
            if (!text) {
              continue;
            }
            logGrokDebug('grok.stream.delta', {
              textLength: text.length,
            });
            const chunk = {
              candidates: [
                {
                  content: {
                    role: 'model',
                    parts: [{ text }],
                  },
                },
              ],
            } as GenerateContentResponse;
            yield chunk;
            continue;
          }

          if (eventType === 'toolCall') {
            const callId = String(payload['callId'] ?? '');
            const name = String(payload['name'] ?? '');
            const rawArgs = payload['arguments'];
            let args: unknown = rawArgs;
            if (typeof rawArgs === 'string') {
              try {
                args = JSON.parse(rawArgs);
              } catch {
                args = rawArgs;
              }
            }
            logGrokDebug('grok.stream.toolCall', {
              callId,
              name,
            });
            const chunk = {
              candidates: [
                {
                  content: {
                    role: 'model',
                    parts: [
                      {
                        functionCall: {
                          id: callId,
                          name,
                          args,
                        },
                      },
                    ],
                  },
                },
              ],
            } as GenerateContentResponse & { functionCalls?: FunctionCall[] };

            chunk.functionCalls = [
              {
                id: callId || undefined,
                name,
                args:
                  typeof args === 'object' && args !== null
                    ? (args as Record<string, unknown>)
                    : { value: args },
              },
            ];
            yield chunk;
            continue;
          }
        }

        const response = await resultPromise;
        logGrokDebug('grok.stream.result.received');
        yield GrokContentGenerator.toGenerateContentResponse(response);
      } finally {
        eventStream.off('event', onEvent);
        eventStream.off('end', onEnd);
        eventStream.off('error', onError);
      }
    }.bind(this);

    return generator();
  }

  private getConfiguredModel(): string | undefined {
    if (typeof this.options.model === 'string' && this.options.model.trim()) {
      return this.options.model.trim();
    }
    const configModelGetter = (
      this.config as unknown as {
        getModel?: () => string | undefined;
      }
    ).getModel;
    if (typeof configModelGetter === 'function') {
      const maybe = configModelGetter();
      if (typeof maybe === 'string' && maybe.trim()) {
        return maybe.trim();
      }
    }
    return undefined;
  }
}
