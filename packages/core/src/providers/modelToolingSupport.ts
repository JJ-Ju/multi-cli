/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ToolResult } from '../tools/tools.js';
import type { WebSearchToolResult } from '../tools/web-search.js';
import type { EditToolParams } from '../tools/edit.js';
import type { CorrectedEditResult } from '../utils/editCorrector.js';
import type { SearchReplaceEdit } from '../utils/llm-edit-fixer.js';
import type { GeminiClient } from '../core/client.js';
import type { BaseLlmClient } from '../core/baseLlmClient.js';
import type { ContentGenerator } from '../core/contentGenerator.js';

export interface SummarizeTextRequest {
  text: string;
  abortSignal: AbortSignal;
  maxOutputTokens?: number;
}

export interface EnsureCorrectEditRequest {
  filePath: string;
  currentContent: string;
  originalParams: EditToolParams;
  abortSignal: AbortSignal;
}

export interface FixEditWithInstructionRequest {
  instruction: string;
  oldString: string;
  newString: string;
  error: string;
  currentContent: string;
  abortSignal: AbortSignal;
}

export interface ModelToolingSupportDependencies {
  conversationClient: GeminiClient;
  contentGenerator?: ContentGenerator;
  baseLlmClient?: BaseLlmClient;
}

export interface ModelToolingSupport {
  performWebSearch(
    query: string,
    abortSignal: AbortSignal,
  ): Promise<WebSearchToolResult>;

  performWebFetch(
    prompt: string,
    abortSignal: AbortSignal,
  ): Promise<ToolResult>;

  ensureCorrectEdit(
    request: EnsureCorrectEditRequest,
  ): Promise<CorrectedEditResult>;

  ensureCorrectFileContent(
    content: string,
    abortSignal: AbortSignal,
  ): Promise<string>;

  fixEditWithInstruction(
    request: FixEditWithInstructionRequest,
  ): Promise<SearchReplaceEdit>;

  summarizeText(request: SummarizeTextRequest): Promise<string>;
}

export class UnsupportedModelToolingSupport implements ModelToolingSupport {
  constructor(private readonly providerId: string) {}

  private notSupported(feature: string): Error {
    return new Error(
      `Model provider ${this.providerId} does not implement tooling feature: ${feature}`,
    );
  }

  performWebSearch(): Promise<WebSearchToolResult> {
    return Promise.reject(this.notSupported('performWebSearch'));
  }

  performWebFetch(): Promise<ToolResult> {
    return Promise.reject(this.notSupported('performWebFetch'));
  }

  ensureCorrectEdit(): Promise<CorrectedEditResult> {
    return Promise.reject(this.notSupported('ensureCorrectEdit'));
  }

  ensureCorrectFileContent(): Promise<string> {
    return Promise.reject(this.notSupported('ensureCorrectFileContent'));
  }

  fixEditWithInstruction(): Promise<SearchReplaceEdit> {
    return Promise.reject(this.notSupported('fixEditWithInstruction'));
  }

  summarizeText(): Promise<string> {
    return Promise.reject(this.notSupported('summarizeText'));
  }
}
