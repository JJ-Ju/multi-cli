/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { WebSearchToolParams } from './web-search.js';
import { WebSearchTool } from './web-search.js';
import type { Config } from '../config/config.js';
import { ToolErrorType } from './tool-error.js';

describe('WebSearchTool', () => {
  const abortSignal = new AbortController().signal;
  let tool: WebSearchTool;
  let mockConfig: Config;
  let mockToolingSupport: {
    performWebSearch: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    mockToolingSupport = {
      performWebSearch: vi.fn(),
    };

    mockConfig = {
      getToolingSupport: vi.fn(() => mockToolingSupport),
      getProxy: () => undefined,
    } as unknown as Config;

    tool = new WebSearchTool(mockConfig);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('build', () => {
    it('returns an invocation for a valid query', () => {
      const params: WebSearchToolParams = { query: 'test query' };
      const invocation = tool.build(params);
      expect(invocation).toBeDefined();
      expect(invocation.params).toEqual(params);
    });

    it('throws for an empty query', () => {
      const params: WebSearchToolParams = { query: '' };
      expect(() => tool.build(params)).toThrow(
        "The 'query' parameter cannot be empty.",
      );
    });

    it('throws for a whitespace-only query', () => {
      const params: WebSearchToolParams = { query: '   ' };
      expect(() => tool.build(params)).toThrow(
        "The 'query' parameter cannot be empty.",
      );
    });
  });

  describe('getDescription', () => {
    it('describes the query being executed', () => {
      const params: WebSearchToolParams = { query: 'describe me' };
      const invocation = tool.build(params);
      expect(invocation.getDescription()).toBe(
        'Searching the web for: "describe me"',
      );
    });
  });

  describe('execute', () => {
    it('delegates to tooling support and returns its result', async () => {
      const params: WebSearchToolParams = { query: 'successful query' };
      const adapterResult = {
        llmContent: 'results',
        returnDisplay: 'display',
        sources: [{ web: { uri: 'https://example.com' } }],
      };
      mockToolingSupport.performWebSearch.mockResolvedValue(adapterResult);

      const invocation = tool.build(params);
      const result = await invocation.execute(abortSignal);

      expect(mockToolingSupport.performWebSearch).toHaveBeenCalledWith(
        'successful query',
        abortSignal,
      );
      expect(result).toEqual(adapterResult);
    });

    it('handles errors from tooling support', async () => {
      const params: WebSearchToolParams = { query: 'error query' };
      mockToolingSupport.performWebSearch.mockRejectedValue(
        new Error('API Failure'),
      );

      const invocation = tool.build(params);
      const result = await invocation.execute(abortSignal);

      expect(result.error?.type).toBe(ToolErrorType.WEB_SEARCH_FAILED);
      expect(result.llmContent).toContain('Error:');
      expect(result.llmContent).toContain('API Failure');
      expect(result.returnDisplay).toBe('Error performing web search.');
    });
  });
});
