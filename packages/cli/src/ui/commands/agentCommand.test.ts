/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, beforeEach, vi } from 'vitest';
import { agentCommand } from './agentCommand.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';
import type { CommandContext, MessageActionReturn } from './types.js';
import { SettingScope } from '../../config/settings.js';

const providerAId = 'google-genai';
const providerBId = 'grok';

describe('agentCommand', () => {
  let mockContext: CommandContext;
  let listModelProvidersMock: ReturnType<typeof vi.fn>;
  let getModelProviderIdMock: ReturnType<typeof vi.fn>;
  let setModelProviderMock: ReturnType<typeof vi.fn>;
  let setValueMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    listModelProvidersMock = vi
      .fn()
      .mockReturnValue([{ id: providerAId }, { id: providerBId }]);
    getModelProviderIdMock = vi.fn().mockReturnValue(providerAId);
    setModelProviderMock = vi.fn();
    setValueMock = vi.fn();

    mockContext = createMockCommandContext({
      services: {
        config: {
          listModelProviders: listModelProvidersMock,
          getModelProviderId: getModelProviderIdMock,
          setModelProvider: setModelProviderMock,
        },
        settings: {
          merged: {},
          setValue: setValueMock,
        },
      },
    });
  });

  it('lists available providers when no arguments are given', async () => {
    if (!agentCommand.action) {
      throw new Error('agentCommand must define an action');
    }

    const message = expectMessage(await agentCommand.action(mockContext, ''));

    expect(message.messageType).toBe('info');
    expect(message.content).toContain('Available model providers:');
    expect(message.content).toContain(providerAId);
    expect(message.content).toContain(providerBId);
  });

  it('switches providers when invoked with `use <provider>`', async () => {
    if (!agentCommand.action) {
      throw new Error('agentCommand must define an action');
    }

    const message = expectMessage(
      await agentCommand.action(mockContext, 'use grok'),
    );

    expect(setModelProviderMock).toHaveBeenCalledWith('grok');
    expect(setValueMock).toHaveBeenCalledWith(
      SettingScope.User,
      'model.provider',
      'grok',
    );
    expect(message.messageType).toBe('info');
    expect(message.content).toBe('Switched active model provider to grok.');
  });

  it('switches providers when invoked with shorthand argument', async () => {
    if (!agentCommand.action) {
      throw new Error('agentCommand must define an action');
    }

    const message = expectMessage(
      await agentCommand.action(mockContext, 'grok'),
    );

    expect(setModelProviderMock).toHaveBeenCalledWith('grok');
    expect(setValueMock).toHaveBeenCalledWith(
      SettingScope.User,
      'model.provider',
      'grok',
    );
    expect(message.messageType).toBe('info');
    expect(message.content).toBe('Switched active model provider to grok.');
  });

  it('returns an error when an unknown provider is requested', async () => {
    if (!agentCommand.action) {
      throw new Error('agentCommand must define an action');
    }

    const message = expectMessage(
      await agentCommand.action(mockContext, 'use unknown'),
    );

    expect(setModelProviderMock).not.toHaveBeenCalled();
    expect(message.messageType).toBe('error');
    expect(message.content).toBe('Unknown model provider: unknown');
  });

  it('surfaces an error when config is unavailable', async () => {
    if (!agentCommand.action) {
      throw new Error('agentCommand must define an action');
    }

    const contextWithoutConfig = createMockCommandContext({
      services: { config: null },
    });

    const message = expectMessage(
      await agentCommand.action(contextWithoutConfig, 'list'),
    );

    expect(message.messageType).toBe('error');
  });
});

function expectMessage(
  result: Awaited<ReturnType<NonNullable<typeof agentCommand.action>>>,
): MessageActionReturn {
  if (!result || result.type !== 'message') {
    throw new Error('Expected message action');
  }
  return result;
}
