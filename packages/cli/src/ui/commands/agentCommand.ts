/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { SettingScope } from '../../config/settings.js';
import {
  CommandKind,
  type MessageActionReturn,
  type SlashCommand,
} from './types.js';

function formatProviderList(
  providerIds: readonly string[],
  activeProviderId: string,
): string {
  const lines = [
    'Available model providers:',
    ...providerIds.map((providerId) => {
      const isActive = providerId === activeProviderId;
      const marker = isActive ? '*' : '-';
      const suffix = isActive ? ' (active)' : '';
      return ` ${marker} ${providerId}${suffix}`;
    }),
  ];

  lines.push(
    '',
    'Use `/agent use <providerId>` or `/agent <providerId>` to switch providers.',
  );

  return lines.join('\n');
}

function createMessage(
  messageType: MessageActionReturn['messageType'],
  content: string,
): MessageActionReturn {
  return {
    type: 'message',
    messageType,
    content,
  };
}

export const agentCommand: SlashCommand = {
  name: 'agent',
  description: 'inspect and switch between model providers',
  kind: CommandKind.BUILT_IN,
  action: async (context, rawArgs) => {
    const config = context.services.config;
    if (!config) {
      return createMessage(
        'error',
        'Configuration is not initialized; unable to manage model providers.',
      );
    }

    const providers = config.listModelProviders();
    if (providers.length === 0) {
      return createMessage('error', 'No model providers are registered.');
    }

    const providerIds = providers.map((provider) => provider.id);
    const activeProviderId = config.getModelProviderId();
    const trimmedArgs = rawArgs.trim();

    if (trimmedArgs.length === 0 || trimmedArgs === 'list') {
      return createMessage(
        'info',
        formatProviderList(providerIds, activeProviderId),
      );
    }

    if (trimmedArgs === 'current') {
      return createMessage(
        'info',
        `Current model provider: ${activeProviderId}`,
      );
    }

    const tokens = trimmedArgs.split(/\s+/).filter(Boolean);
    if (tokens.length === 0) {
      return createMessage(
        'error',
        'You must provide a model provider identifier.',
      );
    }

    let targetProviderId: string | undefined;

    if (tokens.length === 1) {
      const [firstToken] = tokens;
      if (['use', 'switch', 'set'].includes(firstToken)) {
        return createMessage(
          'error',
          'Specify a provider id, e.g. `/agent use google-genai`.',
        );
      }
      targetProviderId = firstToken;
    } else {
      const [firstToken, secondToken] = tokens;
      if (['use', 'switch', 'set'].includes(firstToken)) {
        targetProviderId = secondToken;
      }
    }

    if (!targetProviderId) {
      return createMessage(
        'error',
        `Unrecognised agent command: "${trimmedArgs}".`,
      );
    }

    const providerExists = providerIds.includes(targetProviderId);
    if (!providerExists) {
      return createMessage(
        'error',
        `Unknown model provider: ${targetProviderId}`,
      );
    }

    if (targetProviderId === activeProviderId) {
      return createMessage(
        'info',
        `Model provider ${targetProviderId} is already active.`,
      );
    }

    try {
      await config.setModelProvider(targetProviderId);
    } catch (error) {
      return createMessage(
        'error',
        `Failed to activate provider ${targetProviderId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    if (typeof context.services.settings.setValue === 'function') {
      context.services.settings.setValue(
        SettingScope.User,
        'model.provider',
        targetProviderId,
      );
    }

    return createMessage(
      'info',
      `Switched active model provider to ${targetProviderId}.`,
    );
  },
  completion: async (context, partialArg) => {
    const config = context.services.config;
    if (!config) {
      return [];
    }

    const providers = config
      .listModelProviders()
      .map((provider) => provider.id);
    const trimmed = partialArg.trim();

    if (trimmed.length === 0) {
      return ['list', 'current', 'use', ...providers];
    }

    const tokens = trimmed.split(/\s+/);

    if (tokens.length === 1) {
      const [first] = tokens;
      const options = ['list', 'current', 'use', 'switch', 'set', ...providers];
      return options.filter((option) => option.startsWith(first));
    }

    if (tokens.length === 2 && ['use', 'switch', 'set'].includes(tokens[0])) {
      const [, partialProvider] = tokens;
      return providers.filter((id) => id.startsWith(partialProvider));
    }

    return [];
  },
};
