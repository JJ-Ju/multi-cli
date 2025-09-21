/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ToolResult } from '../tools/tools.js';
import type { WebSearchToolResult } from '../tools/web-search.js';
import type {
  EnsureCorrectEditRequest,
  FixEditWithInstructionRequest,
  ModelToolingSupport,
  SummarizeTextRequest,
} from './modelToolingSupport.js';
import type { CorrectedEditResult } from '../utils/editCorrector.js';
import type { SearchReplaceEdit } from '../utils/llm-edit-fixer.js';
import type {
  GrokEnsureCorrectEditPayload,
  GrokEnsureCorrectFileContentPayload,
  GrokFixEditWithInstructionPayload,
  GrokSummarizeTextPayload,
  GrokToolResultPayload,
} from './grokSidecarClient.js';
import type { GrokSidecarClient } from './grokSidecarClient.js';

interface GrokToolingSupportOptions {
  apiKey: string;
  model?: string;
  pythonPath?: string;
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) {
    return 0;
  }
  return haystack.split(needle).length - 1;
}

export class GrokToolingSupport implements ModelToolingSupport {
  private initialisationPromise?: Promise<void>;

  constructor(
    private readonly sidecar: GrokSidecarClient,
    private readonly options: GrokToolingSupportOptions,
  ) {}

  async performWebSearch(
    query: string,
    abortSignal: AbortSignal,
  ): Promise<WebSearchToolResult> {
    await this.ensureReady();
    const payload: GrokToolResultPayload | undefined =
      await this.sidecar.webSearch(query, { mode: 'on' }, abortSignal);
    const fallback = {
      fallbackContent: `Unable to search for "${query}".`,
      fallbackDisplay: 'Web search failed.',
    };
    return this.toWebToolResult(payload, fallback);
  }

  async performWebFetch(
    prompt: string,
    abortSignal: AbortSignal,
  ): Promise<ToolResult> {
    await this.ensureReady();
    const payload: GrokToolResultPayload | undefined =
      await this.sidecar.webFetch(prompt, {}, abortSignal);
    const fallback = {
      fallbackContent:
        'Web fetch is unavailable for the Grok provider. Please try again later.',
      fallbackDisplay: 'Unable to fetch external content.',
    };
    return this.toToolResult(payload, fallback);
  }

  async ensureCorrectEdit(
    request: EnsureCorrectEditRequest,
  ): Promise<CorrectedEditResult> {
    await this.ensureReady();
    const response: GrokEnsureCorrectEditPayload | undefined =
      await this.sidecar.ensureCorrectEdit(
        {
          filePath: request.filePath,
          currentContent: request.currentContent,
          originalParams: request.originalParams,
        },
        request.abortSignal,
      );

    const occurrences = this.resolveOccurrences(
      request.currentContent,
      request.originalParams.old_string,
      response,
    );
    const params = this.resolveParams(response, request.originalParams);
    return { params, occurrences };
  }

  async ensureCorrectFileContent(
    content: string,
    abortSignal: AbortSignal,
  ): Promise<string> {
    await this.ensureReady();
    const response: GrokEnsureCorrectFileContentPayload | undefined =
      await this.sidecar.ensureCorrectFileContent({ content }, abortSignal);
    const cleaned = response?.content;
    if (typeof cleaned === 'string' && cleaned.length > 0) {
      return cleaned;
    }
    return content;
  }

  async fixEditWithInstruction(
    request: FixEditWithInstructionRequest,
  ): Promise<SearchReplaceEdit> {
    await this.ensureReady();
    const response: GrokFixEditWithInstructionPayload | undefined =
      await this.sidecar.fixEditWithInstruction(
        {
          instruction: request.instruction,
          oldString: request.oldString,
          newString: request.newString,
          error: request.error,
          currentContent: request.currentContent,
        },
        request.abortSignal,
      );

    return this.toSearchReplaceEdit(response, request);
  }

  async summarizeText(request: SummarizeTextRequest): Promise<string> {
    await this.ensureReady();
    const response: GrokSummarizeTextPayload | undefined =
      await this.sidecar.summarizeText(
        {
          text: request.text,
          max_output_tokens: request.maxOutputTokens,
        },
        request.abortSignal,
      );

    const summary = response?.summary;
    if (typeof summary === 'string' && summary.trim()) {
      return summary;
    }
    return request.text;
  }

  // ------------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------------
  private async ensureReady(): Promise<void> {
    if (this.initialisationPromise) {
      await this.initialisationPromise;
      return;
    }

    if (!this.options.apiKey) {
      throw new Error(
        'GROK_API_KEY is required to use the Grok model provider tooling support.',
      );
    }

    const initPromise = this.sidecar
      .ensureInitialised({
        apiKey: this.options.apiKey,
        api_key: this.options.apiKey,
        model: this.options.model,
        pythonPath: this.options.pythonPath,
      })
      .catch((error) => {
        this.initialisationPromise = undefined;
        throw error;
      });

    this.initialisationPromise = initPromise;
    await initPromise;
  }

  private toWebToolResult(
    payload: GrokToolResultPayload | undefined,
    fallback: { fallbackContent: string; fallbackDisplay: string },
  ): WebSearchToolResult {
    const base = this.toToolResult(payload, fallback);
    if (payload?.sources !== undefined) {
      (base as WebSearchToolResult).sources = payload.sources;
    }
    return base as WebSearchToolResult;
  }

  private toToolResult(
    payload: GrokToolResultPayload | undefined,
    fallback: { fallbackContent: string; fallbackDisplay: string },
  ): ToolResult {
    const llmContent = this.pickString(
      payload?.llmContent,
      fallback.fallbackContent,
    );
    const returnDisplay = this.pickString(
      payload?.returnDisplay,
      fallback.fallbackDisplay,
    );

    const result: ToolResult = {
      llmContent,
      returnDisplay,
    };

    const error = this.toToolError(payload?.error);
    if (error) {
      result.error = error;
    }

    return result;
  }

  private toToolError(value: unknown): ToolResult['error'] | undefined {
    if (!value) {
      return undefined;
    }

    if (typeof value === 'string') {
      return { message: value };
    }

    if (typeof value === 'object') {
      const message = (value as { message?: unknown }).message;
      if (typeof message === 'string') {
        return { message };
      }
    }

    return { message: String(value) };
  }

  private resolveOccurrences(
    currentContent: string,
    originalOldString: string,
    response?: GrokEnsureCorrectEditPayload,
  ): number {
    if (response && typeof response.occurrences === 'number') {
      return response.occurrences;
    }
    return countOccurrences(currentContent, originalOldString);
  }

  private resolveParams(
    response: GrokEnsureCorrectEditPayload | undefined,
    original: CorrectedEditResult['params'],
  ): CorrectedEditResult['params'] {
    const params = response?.params;
    if (
      params &&
      typeof params === 'object' &&
      typeof (params as { old_string?: unknown }).old_string === 'string' &&
      typeof (params as { new_string?: unknown }).new_string === 'string'
    ) {
      return {
        ...original,
        ...(params as Record<string, unknown>),
      } as CorrectedEditResult['params'];
    }
    return original;
  }

  private toSearchReplaceEdit(
    response: GrokFixEditWithInstructionPayload | undefined,
    fallback: FixEditWithInstructionRequest,
  ): SearchReplaceEdit {
    const search = this.pickString(response?.search, fallback.oldString);
    const replace = this.pickString(response?.replace, fallback.newString);
    const explanation = this.pickString(
      response?.explanation,
      'Edit parameters adjusted by Grok tooling support.',
    );

    return {
      search,
      replace,
      noChangesRequired: Boolean(response?.noChangesRequired),
      explanation,
    };
  }

  private pickString(value: unknown, fallback: string): string {
    if (typeof value === 'string' && value.trim()) {
      return value;
    }
    return fallback;
  }
}
