/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const BUNDLE_PATH = path.resolve(ROOT, 'bundle', 'gemini.js');
const PROVIDERS_ROOT = path.resolve(ROOT, 'providers');
const STUB_PYTHON_PATH = path.resolve(
  PROVIDERS_ROOT,
  'grok_sidecar',
  'test_support',
);

describe('grok provider smoke test', () => {
  it('streams a response via the Grok sidecar', async () => {
    const env = {
      ...process.env,
      PYTHONPATH: [PROVIDERS_ROOT, STUB_PYTHON_PATH, process.env.PYTHONPATH]
        .filter(Boolean)
        .join(path.delimiter),
      GROK_API_KEY: process.env.GROK_API_KEY || 'stub-api-key',
      GROK_PYTHON_BIN: process.env.GROK_PYTHON_BIN || 'python3',
      GEMINI_API_KEY: process.env.GEMINI_API_KEY || 'stub-gemini-api-key',
      GEMINI_MODEL_PROVIDER: 'grok',
      GEMINI_MODEL: 'grok-beta',
    } as NodeJS.ProcessEnv;

    const child = spawn(
      process.execPath,
      [BUNDLE_PATH, '--prompt', 'Say hello from the grok provider.', '--yolo'],
      {
        cwd: ROOT,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    let stdout = '';
    let stderr = '';

    child.stdout.setEncoding('utf-8');
    child.stderr.setEncoding('utf-8');

    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });

    const exitCode = await new Promise<number>((resolve, reject) => {
      child.on('error', reject);
      child.on('close', resolve);
    });

    if (exitCode !== 0) {
      throw new Error(
        `CLI exited with code ${exitCode}\nStdout:\n${stdout}\nStderr:\n${stderr}`,
      );
    }

    expect(stdout).toContain('[grok-stub] hello');
  }, 20_000);
});
