/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '../config/config.js';
import { DEFAULT_GEMINI_FLASH_MODEL } from '../config/models.js';
import type { ToolResult } from '../tools/tools.js';
import type { WebSearchToolResult } from '../tools/web-search.js';
import { ToolErrorType } from '../tools/tool-error.js';
import { getResponseText } from '../utils/partUtils.js';
import { getErrorMessage } from '../utils/errors.js';
import { fetchWithTimeout, isPrivateIp } from '../utils/fetch.js';
import { summarizeToolOutput } from '../utils/summarizer.js';
import {
  ensureCorrectEdit,
  ensureCorrectFileContent,
} from '../utils/editCorrector.js';
import { FixLLMEditWithInstruction } from '../utils/llm-edit-fixer.js';
import type {
  EnsureCorrectEditRequest,
  FixEditWithInstructionRequest,
  ModelToolingSupport,
  ModelToolingSupportDependencies,
  SummarizeTextRequest,
} from './modelToolingSupport.js';
import type { CorrectedEditResult } from '../utils/editCorrector.js';
import type { SearchReplaceEdit } from '../utils/llm-edit-fixer.js';
import type { GeminiClient } from '../core/client.js';
import type { BaseLlmClient } from '../core/baseLlmClient.js';
import { ProxyAgent, setGlobalDispatcher } from 'undici';
import { convert } from 'html-to-text';

interface GroundingChunkWeb {
  uri?: string;
  title?: string;
}

interface GroundingChunkItem {
  web?: GroundingChunkWeb;
}

interface GroundingSupportSegment {
  startIndex: number;
  endIndex: number;
  text?: string;
}

interface GroundingSupportItem {
  segment?: GroundingSupportSegment;
  groundingChunkIndices?: number[];
  confidenceScores?: number[];
}

const URL_FETCH_TIMEOUT_MS = 10000;
const MAX_CONTENT_LENGTH = 100000;

function extractUrls(text: string): string[] {
  const urlRegex = /(https?:\/\/[^\s]+)/g;
  return text.match(urlRegex) ?? [];
}

export class GoogleToolingSupport implements ModelToolingSupport {
  constructor(
    private readonly config: Config,
    private readonly dependencies: ModelToolingSupportDependencies,
  ) {
    const proxy = this.config.getProxy();
    if (proxy) {
      setGlobalDispatcher(new ProxyAgent(proxy as string));
    }
  }

  async performWebSearch(
    query: string,
    abortSignal: AbortSignal,
  ): Promise<WebSearchToolResult> {
    const geminiClient = this.getConversationClient();

    try {
      const response = await geminiClient.generateContent(
        [{ role: 'user', parts: [{ text: query }] }],
        { tools: [{ googleSearch: {} }] },
        abortSignal,
        DEFAULT_GEMINI_FLASH_MODEL,
      );

      const responseText = getResponseText(response);
      const groundingMetadata = response.candidates?.[0]?.groundingMetadata;
      const sources = groundingMetadata?.groundingChunks as
        | GroundingChunkItem[]
        | undefined;
      const groundingSupports = groundingMetadata?.groundingSupports as
        | GroundingSupportItem[]
        | undefined;

      if (!responseText || !responseText.trim()) {
        return {
          llmContent: `No search results or information found for query: "${query}"`,
          returnDisplay: 'No information found.',
        };
      }

      let modifiedResponseText = responseText;
      const sourceListFormatted: string[] = [];

      if (sources && sources.length > 0) {
        sources.forEach((source: GroundingChunkItem, index: number) => {
          const title = source.web?.title || 'Untitled';
          const uri = source.web?.uri || 'No URI';
          sourceListFormatted.push(`[${index + 1}] ${title} (${uri})`);
        });

        if (groundingSupports && groundingSupports.length > 0) {
          const insertions: Array<{ index: number; marker: string }> = [];
          groundingSupports.forEach((support: GroundingSupportItem) => {
            if (support.segment && support.groundingChunkIndices) {
              const citationMarker = support.groundingChunkIndices
                .map((chunkIndex: number) => `[${chunkIndex + 1}]`)
                .join('');
              insertions.push({
                index: support.segment.endIndex,
                marker: citationMarker,
              });
            }
          });

          insertions.sort((a, b) => b.index - a.index);
          const encoder = new TextEncoder();
          const originalBytes = encoder.encode(modifiedResponseText);
          const parts: Uint8Array[] = [];
          let lastIndex = originalBytes.length;
          for (const insertion of insertions) {
            const index = Math.min(insertion.index, lastIndex);
            parts.unshift(originalBytes.subarray(index, lastIndex));
            parts.unshift(encoder.encode(insertion.marker));
            lastIndex = index;
          }
          parts.unshift(originalBytes.subarray(0, lastIndex));

          const totalLength = parts.reduce((sum, p) => sum + p.length, 0);
          const merged = new Uint8Array(totalLength);
          let offset = 0;
          for (const part of parts) {
            merged.set(part, offset);
            offset += part.length;
          }
          modifiedResponseText = new TextDecoder().decode(merged);
        }

        if (sourceListFormatted.length > 0) {
          modifiedResponseText +=
            '\n\nSources:\n' + sourceListFormatted.join('\n');
        }
      }

      return {
        llmContent: `Web search results for "${query}":\n\n${modifiedResponseText}`,
        returnDisplay: `Search results for "${query}" returned.`,
        sources,
      };
    } catch (error: unknown) {
      const message = `Error during web search for query "${query}": ${getErrorMessage(error)}`;
      console.error(message, error);
      return {
        llmContent: `Error: ${message}`,
        returnDisplay: `Error performing web search.`,
        error: {
          message,
          type: ToolErrorType.WEB_SEARCH_FAILED,
        },
      };
    }
  }

  async performWebFetch(
    prompt: string,
    abortSignal: AbortSignal,
  ): Promise<ToolResult> {
    const urls = extractUrls(prompt);
    if (urls.length === 0) {
      return {
        llmContent:
          'No valid URLs detected in the prompt. Please include at least one http:// or https:// URL.',
        returnDisplay: 'No URLs provided.',
        error: {
          message: 'No URLs provided.',
          type: ToolErrorType.WEB_FETCH_PROCESSING_ERROR,
        },
      };
    }

    const firstUrl = urls[0];
    if (isPrivateIp(firstUrl)) {
      return this.executeFetchFallback(firstUrl, prompt, abortSignal);
    }

    const geminiClient = this.getConversationClient();

    try {
      const response = await geminiClient.generateContent(
        [{ role: 'user', parts: [{ text: prompt }] }],
        { tools: [{ urlContext: {} }] },
        abortSignal,
        DEFAULT_GEMINI_FLASH_MODEL,
      );

      let responseText = getResponseText(response) || '';
      const candidate = response.candidates?.[0];
      const urlMeta = candidate?.urlContextMetadata;
      const groundingMetadata = candidate?.groundingMetadata;
      const sources = groundingMetadata?.groundingChunks as
        | GroundingChunkItem[]
        | undefined;
      const groundingSupports = groundingMetadata?.groundingSupports as
        | GroundingSupportItem[]
        | undefined;

      let processingError = false;
      if (urlMeta?.urlMetadata && urlMeta.urlMetadata.length > 0) {
        const statuses = urlMeta.urlMetadata.map((m) => m.urlRetrievalStatus);
        if (statuses.every((s) => s !== 'URL_RETRIEVAL_STATUS_SUCCESS')) {
          processingError = true;
        }
      } else if (!responseText.trim() && !sources?.length) {
        processingError = true;
      }

      if (
        !processingError &&
        !responseText.trim() &&
        (!sources || sources.length === 0)
      ) {
        processingError = true;
      }

      if (processingError) {
        return this.executeFetchFallback(firstUrl, prompt, abortSignal);
      }

      const formattedSources: string[] = [];
      if (sources && sources.length > 0) {
        sources.forEach((source: GroundingChunkItem, index: number) => {
          const title = source.web?.title || 'Untitled';
          const uri = source.web?.uri || 'Unknown URI';
          formattedSources.push(`[${index + 1}] ${title} (${uri})`);
        });

        if (groundingSupports && groundingSupports.length > 0) {
          const insertions: Array<{ index: number; marker: string }> = [];
          groundingSupports.forEach((support: GroundingSupportItem) => {
            if (support.segment && support.groundingChunkIndices) {
              const marker = support.groundingChunkIndices
                .map((chunkIndex) => `[${chunkIndex + 1}]`)
                .join('');
              insertions.push({ index: support.segment.endIndex, marker });
            }
          });

          insertions.sort((a, b) => b.index - a.index);
          const characters = responseText.split('');
          insertions.forEach((insertion) => {
            characters.splice(insertion.index, 0, insertion.marker);
          });
          responseText = characters.join('');
        }

        if (formattedSources.length > 0) {
          responseText += `\n\nSources:\n${formattedSources.join('\n')}`;
        }
      }

      return {
        llmContent: responseText,
        returnDisplay: `Content processed from prompt.`,
      };
    } catch (error: unknown) {
      const message = `Error processing web content for prompt "${prompt.substring(
        0,
        50,
      )}...": ${getErrorMessage(error)}`;
      console.error(message, error);
      return {
        llmContent: `Error: ${message}`,
        returnDisplay: `Error: ${message}`,
        error: {
          message,
          type: ToolErrorType.WEB_FETCH_PROCESSING_ERROR,
        },
      };
    }
  }

  async ensureCorrectEdit(
    request: EnsureCorrectEditRequest,
  ): Promise<CorrectedEditResult> {
    const { filePath, currentContent, originalParams, abortSignal } = request;
    return ensureCorrectEdit(
      filePath,
      currentContent,
      originalParams,
      this.getConversationClient(),
      this.getBaseLlmClient(),
      abortSignal,
    );
  }

  async ensureCorrectFileContent(
    content: string,
    abortSignal: AbortSignal,
  ): Promise<string> {
    return ensureCorrectFileContent(
      content,
      this.getBaseLlmClient(),
      abortSignal,
    );
  }

  async fixEditWithInstruction(
    request: FixEditWithInstructionRequest,
  ): Promise<SearchReplaceEdit> {
    return FixLLMEditWithInstruction(
      request.instruction,
      request.oldString,
      request.newString,
      request.error,
      request.currentContent,
      this.getBaseLlmClient(),
      request.abortSignal,
    );
  }

  async summarizeText(request: SummarizeTextRequest): Promise<string> {
    return summarizeToolOutput(
      request.text,
      this.getConversationClient(),
      request.abortSignal,
      request.maxOutputTokens ?? 2000,
    );
  }

  private async executeFetchFallback(
    url: string,
    originalPrompt: string,
    abortSignal: AbortSignal,
  ): Promise<ToolResult> {
    let targetUrl = url;
    if (targetUrl.includes('github.com') && targetUrl.includes('/blob/')) {
      targetUrl = targetUrl
        .replace('github.com', 'raw.githubusercontent.com')
        .replace('/blob/', '/');
    }

    try {
      const response = await fetchWithTimeout(targetUrl, URL_FETCH_TIMEOUT_MS);
      if (!response.ok) {
        throw new Error(
          `Request failed with status code ${response.status} ${response.statusText}`,
        );
      }
      const html = await response.text();
      const textContent = convert(html, {
        wordwrap: false,
        selectors: [
          { selector: 'a', options: { ignoreHref: true } },
          { selector: 'img', format: 'skip' },
        ],
      }).substring(0, MAX_CONTENT_LENGTH);

      const prompt = `The user requested the following: "${originalPrompt}".

I was unable to access the URL directly using urlContext. Instead, I have fetched the raw content of the page. Please use the following content to answer the request. Do not attempt to access the URL again.

---
${textContent}
---
`;

      const geminiClient = this.getConversationClient();
      const result = await geminiClient.generateContent(
        [{ role: 'user', parts: [{ text: prompt }] }],
        {},
        abortSignal,
        DEFAULT_GEMINI_FLASH_MODEL,
      );
      const resultText = getResponseText(result) || '';
      return {
        llmContent: resultText,
        returnDisplay: `Content for ${targetUrl} processed using fallback fetch.`,
      };
    } catch (error: unknown) {
      const message = `Error during fallback fetch for ${targetUrl}: ${getErrorMessage(error)}`;
      return {
        llmContent: `Error: ${message}`,
        returnDisplay: `Error: ${message}`,
        error: {
          message,
          type: ToolErrorType.WEB_FETCH_FALLBACK_FAILED,
        },
      };
    }
  }

  private getConversationClient(): GeminiClient {
    return (
      this.dependencies.conversationClient ?? this.config.getGeminiClient()
    );
  }

  private getBaseLlmClient(): BaseLlmClient {
    return this.dependencies.baseLlmClient ?? this.config.getBaseLlmClient();
  }
}
