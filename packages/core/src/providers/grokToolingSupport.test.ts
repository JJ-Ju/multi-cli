/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, beforeEach, vi } from 'vitest';

import { GrokToolingSupport } from './grokToolingSupport.js';
import type { GrokSidecarClient } from './grokSidecarClient.js';

function createSupport(overrides: Partial<GrokSidecarClient> = {}) {
  const sidecar = {
    ensureInitialised: vi.fn().mockResolvedValue(undefined),
    webSearch: vi.fn().mockResolvedValue({
      llmContent: 'search-response',
      returnDisplay: 'display',
      sources: ['https://example.com'],
    }),
    webFetch: vi.fn().mockResolvedValue({
      llmContent: 'fetch-response',
      returnDisplay: 'display',
    }),
    ensureCorrectEdit: vi.fn().mockResolvedValue({
      params: {
        file_path: 'file',
        old_string: 'foo',
        new_string: 'bar',
      },
      occurrences: 2,
    }),
    ensureCorrectFileContent: vi.fn().mockResolvedValue({
      content: 'clean-content',
    }),
    fixEditWithInstruction: vi.fn().mockResolvedValue({
      search: 'foo',
      replace: 'bar',
      explanation: 'done',
    }),
    summarizeText: vi.fn().mockResolvedValue({ summary: 'summary' }),
    ...overrides,
  } as unknown as GrokSidecarClient;

  const support = new GrokToolingSupport(sidecar, {
    apiKey: 'test-key',
    model: 'grok-4-fast-reasoning',
  });

  return { support, sidecar };
}

describe('GrokToolingSupport', () => {
  let abortSignal: AbortSignal;

  beforeEach(() => {
    abortSignal = new AbortController().signal;
  });

  it('performs web search via sidecar', async () => {
    const { support, sidecar } = createSupport();
    const result = await support.performWebSearch('query', abortSignal);

    expect(sidecar.ensureInitialised).toHaveBeenCalledOnce();
    expect(sidecar.webSearch).toHaveBeenCalledWith(
      'query',
      expect.objectContaining({ mode: 'on' }),
      abortSignal,
    );
    expect(result.llmContent).toBe('search-response');
    expect(result.returnDisplay).toBe('display');
    expect(result.sources).toEqual(['https://example.com']);
  });

  it('ensures correct edit uses sidecar response', async () => {
    const { support } = createSupport();
    const result = await support.ensureCorrectEdit({
      filePath: 'file',
      currentContent: 'foo baz foo',
      originalParams: {
        file_path: 'file',
        old_string: 'baz',
        new_string: 'qux',
      },
      abortSignal,
    });

    expect(result.params.old_string).toBe('foo');
    expect(result.params.new_string).toBe('bar');
    expect(result.occurrences).toBe(2);
  });

  it('falls back to original text when summarise payload empty', async () => {
    const { support, sidecar } = createSupport({
      summarizeText: vi.fn().mockResolvedValue({ summary: '' }),
    });

    const text = await support.summarizeText({
      text: 'fallback text',
      abortSignal,
    });

    expect(sidecar.ensureInitialised).toHaveBeenCalledOnce();
    expect(text).toBe('fallback text');
  });
});
