/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import os from 'node:os';
import path from 'node:path';

/**
 * Replaces the user's home directory with a tilde prefix.
 */
export function tildeifyPath(filePath: string): string {
  const homeDir = os.homedir();
  return filePath.startsWith(homeDir)
    ? filePath.replace(homeDir, '~')
    : filePath;
}

/**
 * Shortens a filesystem path while preserving the first and last segments.
 */
export function shortenPath(filePath: string, maxLen: number = 35): string {
  if (filePath.length <= maxLen) {
    return filePath;
  }

  const parsed = path.parse(filePath);
  const root = parsed.root;
  const separator = path.sep;

  const segments = filePath.slice(root.length).split(separator).filter(Boolean);

  if (segments.length <= 1) {
    const keep = Math.max(Math.floor((maxLen - 3) / 2), 1);
    return `${filePath.slice(0, keep)}...${filePath.slice(-keep)}`;
  }

  const first = segments[0];
  const last = segments[segments.length - 1];

  const tail: string[] = [];
  let consumed = last.length;
  for (let i = segments.length - 2; i > 0; i--) {
    const segment = segments[i];
    const cost = segment.length + separator.length;
    if (consumed + cost > maxLen - root.length - first.length - 4) {
      break;
    }
    consumed += cost;
    tail.unshift(segment);
  }

  const middle = tail.length > 0 ? separator + tail.join(separator) : '';
  return `${root}${first}${separator}...${middle}${separator}${last}`;
}
