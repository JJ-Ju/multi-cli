/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WebFetchTool } from './web-fetch.js';
import type { Config } from '../config/config.js';
import { ApprovalMode } from '../config/config.js';
import { ToolConfirmationOutcome } from './tools.js';
import { ToolErrorType } from './tool-error.js';

describe('WebFetchTool', () => {
  let mockConfig: Config;
  let mockToolingSupport: {
    performWebFetch: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.resetAllMocks();
    mockToolingSupport = {
      performWebFetch: vi.fn(),
    };
    mockConfig = {
      getApprovalMode: vi.fn(() => ApprovalMode.DEFAULT),
      setApprovalMode: vi.fn(),
      getProxy: vi.fn(),
      getToolingSupport: vi.fn(() => mockToolingSupport),
    } as unknown as Config;
  });

  describe('execute', () => {
    it('delegates to tooling support', async () => {
      const tool = new WebFetchTool(mockConfig);
      const params = { prompt: 'fetch https://example.com' };
      const invocation = tool.build(params);
      const adapterResult = {
        llmContent: 'content',
        returnDisplay: 'display',
      };
      mockToolingSupport.performWebFetch.mockResolvedValue(adapterResult);

      const signal = new AbortController().signal;
      const result = await invocation.execute(signal);

      expect(mockToolingSupport.performWebFetch).toHaveBeenCalledWith(
        'fetch https://example.com',
        signal,
      );
      expect(result).toEqual(adapterResult);
    });

    it('wraps tooling errors with WEB_FETCH_PROCESSING_ERROR', async () => {
      const tool = new WebFetchTool(mockConfig);
      const params = { prompt: 'fetch https://example.com' };
      const invocation = tool.build(params);
      mockToolingSupport.performWebFetch.mockRejectedValue(
        new Error('API error'),
      );

      const result = await invocation.execute(new AbortController().signal);

      expect(result.error?.type).toBe(ToolErrorType.WEB_FETCH_PROCESSING_ERROR);
      expect(result.llmContent).toContain('API error');
    });
  });

  describe('shouldConfirmExecute', () => {
    it('returns confirmation details with converted URLs', async () => {
      const tool = new WebFetchTool(mockConfig);
      const params = {
        prompt:
          'fetch https://github.com/google/gemini-react/blob/main/README.md',
      };
      const invocation = tool.build(params);
      const confirmationDetails = await invocation.shouldConfirmExecute(
        new AbortController().signal,
      );

      expect(confirmationDetails).toEqual({
        type: 'info',
        title: 'Confirm Web Fetch',
        prompt:
          'fetch https://github.com/google/gemini-react/blob/main/README.md',
        urls: [
          'https://raw.githubusercontent.com/google/gemini-react/main/README.md',
        ],
        onConfirm: expect.any(Function),
      });
    });

    it('returns false when approval mode is AUTO_EDIT', async () => {
      vi.spyOn(mockConfig, 'getApprovalMode').mockReturnValue(
        ApprovalMode.AUTO_EDIT,
      );
      const tool = new WebFetchTool(mockConfig);
      const params = { prompt: 'fetch https://example.com' };
      const invocation = tool.build(params);
      const confirmationDetails = await invocation.shouldConfirmExecute(
        new AbortController().signal,
      );

      expect(confirmationDetails).toBe(false);
    });

    it('updates approval mode when proceeding always', async () => {
      const tool = new WebFetchTool(mockConfig);
      const params = { prompt: 'fetch https://example.com' };
      const invocation = tool.build(params);
      const confirmationDetails = await invocation.shouldConfirmExecute(
        new AbortController().signal,
      );

      if (
        confirmationDetails &&
        typeof confirmationDetails === 'object' &&
        'onConfirm' in confirmationDetails
      ) {
        await confirmationDetails.onConfirm(
          ToolConfirmationOutcome.ProceedAlways,
        );
      }

      expect(mockConfig.setApprovalMode).toHaveBeenCalledWith(
        ApprovalMode.AUTO_EDIT,
      );
    });
  });
});
