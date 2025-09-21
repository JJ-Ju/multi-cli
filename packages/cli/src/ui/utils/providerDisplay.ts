/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Maps an internal provider identifier to a user-facing label.
 */
export function getProviderDisplayName(
  providerId?: string,
): string | undefined {
  if (!providerId) {
    return undefined;
  }
  const trimmed = providerId.trim();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed === 'google-genai') {
    return 'gemini';
  }
  return trimmed;
}
