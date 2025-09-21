/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { Box, Text } from 'ink';
import { theme } from '../semantic-colors.js';
import { getProviderDisplayName } from '../utils/providerDisplay.js';

interface ConsoleSummaryDisplayProps {
  errorCount: number;
  modelProviderId?: string;
  model: string;
}

export const ConsoleSummaryDisplay: React.FC<ConsoleSummaryDisplayProps> = ({
  errorCount,
  modelProviderId,
  model,
}) => {
  const providerLabel =
    modelProviderId &&
    (getProviderDisplayName(modelProviderId) ?? modelProviderId);
  const providerDisplay = providerLabel ? `${providerLabel} · ${model}` : model;
  const errorIcon = '\u2716'; // Heavy multiplication x (✖)

  return (
    <Box alignItems="center">
      <Text color={theme.text.secondary}>{providerDisplay}</Text>
      {errorCount > 0 && (
        <Box marginLeft={1}>
          <Text color={theme.ui.comment}>| </Text>
          <Text color={theme.status.error}>
            {errorIcon} {errorCount} error{errorCount > 1 ? 's' : ''}
          </Text>
          <Text color={theme.text.secondary}> (ctrl+o for details)</Text>
        </Box>
      )}
    </Box>
  );
};
