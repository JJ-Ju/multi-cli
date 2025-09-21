/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { Text, Box } from 'ink';
import stringWidth from 'string-width';
import { MarkdownDisplay } from '../../utils/MarkdownDisplay.js';
import { theme } from '../../semantic-colors.js';
import { SCREEN_READER_MODEL_PREFIX } from '../../textConstants.js';
import { getProviderDisplayName } from '../../utils/providerDisplay.js';

interface GeminiMessageProps {
  text: string;
  isPending: boolean;
  availableTerminalHeight?: number;
  terminalWidth: number;
  modelProviderId?: string;
}

export function getModelMessagePrefix(providerId?: string): {
  prefix: string;
  width: number;
  ariaLabel: string;
} {
  const displayProvider = getProviderDisplayName(providerId);
  if (!displayProvider) {
    const prefix = '✦ ';
    return {
      prefix,
      width: stringWidth(prefix),
      ariaLabel: SCREEN_READER_MODEL_PREFIX,
    };
  }

  const prefix = `✦ ${displayProvider} · `;
  return {
    prefix,
    width: stringWidth(prefix),
    ariaLabel: `Model (${displayProvider}): `,
  };
}

export const GeminiMessage: React.FC<GeminiMessageProps> = ({
  text,
  isPending,
  availableTerminalHeight,
  terminalWidth,
  modelProviderId,
}) => {
  const {
    prefix,
    width: prefixWidth,
    ariaLabel,
  } = getModelMessagePrefix(modelProviderId);

  return (
    <Box flexDirection="row">
      <Box width={prefixWidth}>
        <Text color={theme.text.accent} aria-label={ariaLabel}>
          {prefix}
        </Text>
      </Box>
      <Box flexGrow={1} flexDirection="column">
        <MarkdownDisplay
          text={text}
          isPending={isPending}
          availableTerminalHeight={availableTerminalHeight}
          terminalWidth={terminalWidth}
        />
      </Box>
    </Box>
  );
};
