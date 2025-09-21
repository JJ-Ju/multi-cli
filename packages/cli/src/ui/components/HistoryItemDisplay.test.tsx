/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { render } from 'ink-testing-library';
import { describe, it, expect, vi } from 'vitest';
import { HistoryItemDisplay } from './HistoryItemDisplay.js';
import type { HistoryItem } from '../types.js';
import { MessageType, ToolCallStatus } from '../types.js';
import { SessionStatsProvider } from '../contexts/SessionContext.js';
import type { Config } from '@google/gemini-cli-core';

// Mock child components
vi.mock('./messages/ToolGroupMessage.js', () => ({
  ToolGroupMessage: () => <div />,
}));

describe('<HistoryItemDisplay />', () => {
  const mockConfig = {} as unknown as Config;
  const baseItem = {
    id: 1,
    timestamp: 12345,
    isPending: false,
    terminalWidth: 80,
    config: mockConfig,
  };

  it('renders UserMessage for "user" type', () => {
    const item: HistoryItem = {
      ...baseItem,
      type: MessageType.USER,
      text: 'Hello',
    };
    const { lastFrame } = render(
      <HistoryItemDisplay {...baseItem} item={item} />,
    );
    expect(lastFrame()).toContain('Hello');
  });

  it('renders UserMessage for "user" type with slash command', () => {
    const item: HistoryItem = {
      ...baseItem,
      type: MessageType.USER,
      text: '/theme',
    };
    const { lastFrame } = render(
      <HistoryItemDisplay {...baseItem} item={item} />,
    );
    expect(lastFrame()).toContain('/theme');
  });

  it('renders StatsDisplay for "stats" type', () => {
    const item: HistoryItem = {
      ...baseItem,
      type: MessageType.STATS,
      duration: '1s',
    };
    const { lastFrame } = render(
      <SessionStatsProvider>
        <HistoryItemDisplay {...baseItem} item={item} />
      </SessionStatsProvider>,
    );
    expect(lastFrame()).toContain('Stats');
  });

  it('renders AboutBox for "about" type', () => {
    const item: HistoryItem = {
      ...baseItem,
      type: MessageType.ABOUT,
      cliVersion: '1.0.0',
      osVersion: 'test-os',
      sandboxEnv: 'test-env',
      modelVersion: 'test-model',
      modelProvider: 'test-provider',
      selectedAuthType: 'test-auth',
      gcpProject: 'test-project',
      ideClient: 'test-ide',
    };
    const { lastFrame } = render(
      <HistoryItemDisplay {...baseItem} item={item} />,
    );
    expect(lastFrame()).toContain('About Gemini CLI');
  });

  it('renders ModelStatsDisplay for "model_stats" type', () => {
    const item: HistoryItem = {
      ...baseItem,
      type: 'model_stats',
    };
    const { lastFrame } = render(
      <SessionStatsProvider>
        <HistoryItemDisplay {...baseItem} item={item} />
      </SessionStatsProvider>,
    );
    expect(lastFrame()).toContain(
      'No API calls have been made in this session.',
    );
  });

  it('renders ToolStatsDisplay for "tool_stats" type', () => {
    const item: HistoryItem = {
      ...baseItem,
      type: 'tool_stats',
    };
    const { lastFrame } = render(
      <SessionStatsProvider>
        <HistoryItemDisplay {...baseItem} item={item} />
      </SessionStatsProvider>,
    );
    expect(lastFrame()).toContain(
      'No tool calls have been made in this session.',
    );
  });

  it('renders SessionSummaryDisplay for "quit" type', () => {
    const item: HistoryItem = {
      ...baseItem,
      type: 'quit',
      duration: '1s',
    };
    const { lastFrame } = render(
      <SessionStatsProvider>
        <HistoryItemDisplay {...baseItem} item={item} />
      </SessionStatsProvider>,
    );
    expect(lastFrame()).toContain('Agent powering down. Goodbye!');
  });

  it('renders provider badge for gemini responses when provider is set', () => {
    const item: HistoryItem = {
      ...baseItem,
      type: 'gemini',
      text: 'Streaming response',
      modelProviderId: 'grok',
    };
    const { lastFrame } = render(
      <HistoryItemDisplay {...baseItem} item={item} />,
    );
    expect(lastFrame()).toContain('✦ grok ·');
    expect(lastFrame()).toContain('Streaming response');
  });

  it('renders provider badge for tool groups when provider differs from gemini', () => {
    const item: HistoryItem = {
      ...baseItem,
      type: 'tool_group',
      tools: [
        {
          callId: 'call-123',
          name: 'run_shell_command',
          description: 'Run shell command',
          status: ToolCallStatus.Pending,
          resultDisplay: undefined,
          confirmationDetails: undefined,
        },
      ],
      modelProviderId: 'grok',
    };
    const { lastFrame } = render(
      <HistoryItemDisplay {...baseItem} item={item} />,
    );
    expect(lastFrame()).toContain('✦ grok');
  });
});
