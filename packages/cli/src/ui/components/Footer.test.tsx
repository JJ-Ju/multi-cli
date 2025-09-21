/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { render } from 'ink-testing-library';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { Text } from 'ink';
import * as useTerminalSize from '../hooks/useTerminalSize.js';
import path from 'node:path';

const shortenPathMock = vi.fn((p: string, len: number) => {
  if (p.length > len) {
    return '...' + p.slice(p.length - len + 3);
  }
  return p;
});

const tildeifyPathMock = vi.fn((p: string) => p);

vi.mock('../hooks/useTerminalSize.js');
const useTerminalSizeMock = vi.mocked(useTerminalSize.useTerminalSize);

beforeAll(async () => {
  await vi.doMock('../../utils/corePaths.js', () => ({
    shortenPath: shortenPathMock,
    tildeifyPath: tildeifyPathMock,
  }));

  await vi.doMock('./ContextUsageDisplay.js', () => ({
    ContextUsageDisplay: ({
      promptTokenCount,
    }: {
      promptTokenCount: number;
    }) => <Text>Context:{promptTokenCount}</Text>,
  }));

  await vi.doMock('./MemoryUsageDisplay.js', () => ({
    MemoryUsageDisplay: () => <Text>MemoryUsage</Text>,
  }));
});

beforeEach(() => {
  shortenPathMock.mockClear();
  tildeifyPathMock.mockClear();
});

const defaultProps = {
  model: 'gemini-pro',
  modelProviderId: 'google-genai',
  targetDir:
    '/Users/test/project/foo/bar/and/some/more/directories/to/make/it/long',
  branchName: 'main',
  debugMode: false,
  debugMessage: '',
  corgiMode: false,
  errorCount: 0,
  showErrorDetails: false,
  showMemoryUsage: false,
  promptTokenCount: 100,
  nightly: false,
};

const renderFooter = async (width: number, props = defaultProps) => {
  useTerminalSizeMock.mockReturnValue({ columns: width, rows: 24 });
  const module = await import('./Footer.js');
  const Footer = module.Footer;
  return render(<Footer {...props} />);
};

describe('<Footer />', () => {
  it('renders the component', async () => {
    const { lastFrame } = await renderFooter(120);
    expect(lastFrame()).toBeDefined();
  });

  describe('path display', () => {
    it('should display shortened path on a wide terminal', async () => {
      await renderFooter(120);
      expect(tildeifyPathMock).toHaveBeenCalledWith(defaultProps.targetDir);
      expect(shortenPathMock).toHaveBeenCalled();
      const [pathArg, lenArg] = shortenPathMock.mock.calls.at(-1)!;
      expect(pathArg).toBe(tildeifyPathMock.mock.calls.at(-1)![0]);
      expect(lenArg).toBe(Math.max(20, Math.floor(120 * 0.4)));
    });

    it('should display only the base directory name on a narrow terminal', async () => {
      const { lastFrame } = await renderFooter(79);
      expect(shortenPathMock).not.toHaveBeenCalled();
      const expectedPath = path.basename(defaultProps.targetDir);
      expect(lastFrame().replace(/\s+/g, ' ')).toContain(expectedPath);
    });

    it('should use wide layout at 80 columns', async () => {
      await renderFooter(80);
      expect(shortenPathMock).toHaveBeenCalled();
      const [, lenArg] = shortenPathMock.mock.calls.at(-1)!;
      expect(lenArg).toBe(Math.max(20, Math.floor(80 * 0.4)));
    });

    it('should use narrow layout at 79 columns', async () => {
      const { lastFrame } = await renderFooter(79);
      const expectedPath = path.basename(defaultProps.targetDir);
      expect(lastFrame().replace(/\s+/g, ' ')).toContain(expectedPath);
      expect(shortenPathMock).not.toHaveBeenCalled();
    });
  });

  it('displays the branch name when provided', async () => {
    const { lastFrame } = await renderFooter(120);
    expect(lastFrame()).toContain(`(${defaultProps.branchName}*)`);
  });

  it('does not display the branch name when not provided', async () => {
    const { lastFrame } = await renderFooter(120, {
      ...defaultProps,
      branchName: undefined,
    });
    expect(lastFrame()).not.toContain(`(${defaultProps.branchName}*)`);
  });

  it('displays the model provider and name', async () => {
    const { lastFrame } = await renderFooter(120);
    expect(lastFrame()).toContain(`gemini · ${defaultProps.model}`);
    expect(lastFrame()).toContain('Context:100');
  });

  it('displays non-default provider id when set', async () => {
    const { lastFrame } = await renderFooter(120, {
      ...defaultProps,
      modelProviderId: 'grok',
    });
    expect(lastFrame()).toContain(`grok · ${defaultProps.model}`);
  });

  it('shows provider summary when model info is hidden', async () => {
    const { lastFrame } = await renderFooter(120, {
      ...defaultProps,
      hideModelInfo: true,
    });
    const normalized = lastFrame().replace(/\s+/g, ' ');
    expect(normalized).toContain('gemini ·');
    expect(normalized).toContain('gemini-pro');
  });

  it('falls back to model name when provider id unavailable', async () => {
    const { lastFrame } = await renderFooter(120, {
      ...defaultProps,
      modelProviderId: undefined,
    });
    expect(lastFrame()).toContain(defaultProps.model);
  });
});
