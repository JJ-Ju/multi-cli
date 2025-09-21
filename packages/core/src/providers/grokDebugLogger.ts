/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const DEFAULT_LOG_FILE = process.env['GROK_DEBUG_LOG_FILE']
  ? path.resolve(process.env['GROK_DEBUG_LOG_FILE'])
  : path.join(process.cwd(), 'grok-debug.log');

function ensureDirectoryExists(filePath: string): void {
  const dir = path.dirname(filePath);
  try {
    mkdirSync(dir, { recursive: true });
  } catch (_error) {
    // Ignore directory creation errors; logging will fallback to append attempt.
  }
}

export function logGrokDebug(
  message: string,
  details?: Record<string, unknown>,
): void {
  const timestamp = new Date().toISOString();
  let line = `[${timestamp}] ${message}`;
  if (details) {
    try {
      line += ` ${JSON.stringify(details)}`;
    } catch (_error) {
      // Ignore serialization issues.
    }
  }

  try {
    ensureDirectoryExists(DEFAULT_LOG_FILE);
    appendFileSync(DEFAULT_LOG_FILE, `${line}\n`, { encoding: 'utf8' });
  } catch (_error) {
    // Swallow logging errors to avoid interrupting CLI flow.
  }
}
