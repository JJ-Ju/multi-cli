/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '../config/config.js';
import type {
  ContentGenerator,
  ContentGeneratorConfig,
} from '../core/contentGenerator.js';
import { GeminiClient } from '../core/client.js';
import type { ModelProvider } from './types.js';
import { GrokSidecarClient } from './grokSidecarClient.js';
import { GrokContentGenerator } from './grokContentGenerator.js';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as dotenv from 'dotenv';

const DEFAULT_MODEL_ID = 'grok-4-fast-reasoning-latest';

export class GrokProvider implements ModelProvider {
  readonly id = 'grok';

  private sidecar?: GrokSidecarClient;
  private envLoaded = false;

  getDefaultModelId(): string {
    this.ensureEnvironment();
    return this.getEnvModel() ?? DEFAULT_MODEL_ID;
  }

  isModelSupported(modelId: string): boolean {
    if (typeof modelId !== 'string') {
      return false;
    }
    const normalised = modelId.trim().toLowerCase();
    if (!normalised) {
      return false;
    }
    if (normalised === 'auto') {
      return true;
    }
    return normalised.startsWith('grok');
  }

  createContentGeneratorConfig(
    config: Config,
    _authType: undefined,
  ): ContentGeneratorConfig {
    this.ensureEnvironment();
    return {
      apiKey: process.env['GROK_API_KEY'] || '',
      authType: undefined,
      proxy: config.getProxy(),
    };
  }

  async createContentGenerator(
    generatorConfig: ContentGeneratorConfig,
    config: Config,
    _sessionId?: string,
  ): Promise<ContentGenerator> {
    const sidecar = this.ensureSidecar();
    return new GrokContentGenerator(config, sidecar, {
      apiKey: generatorConfig.apiKey || '',
      model: config.getModel(),
      pythonPath: process.env['GROK_PYTHON_BIN'],
    });
  }

  createConversationClient(config: Config): GeminiClient {
    return new GeminiClient(config);
  }

  private ensureSidecar(): GrokSidecarClient {
    if (!this.sidecar) {
      const { packageRoot } = this.resolveLocations();
      const providersDir = path.join(packageRoot, 'providers');
      const workingDir = existsSync(providersDir) ? packageRoot : process.cwd();
      this.sidecar = new GrokSidecarClient(workingDir);
    }
    return this.sidecar;
  }

  private ensureEnvironment(): void {
    if (this.envLoaded) {
      return;
    }

    const { packageRoot } = this.resolveLocations();
    const candidatePaths = [
      path.join(packageRoot, '.env'),
      path.join(packageRoot, 'providers', 'grok_sidecar', '.env'),
      path.join(process.cwd(), '.env'),
    ];

    for (const candidate of candidatePaths) {
      if (!existsSync(candidate)) {
        continue;
      }
      try {
        const parsed = dotenv.parse(readFileSync(candidate, 'utf-8'));
        this.applyEnvValue(parsed, 'GROK_API_KEY');
        this.applyEnvValue(parsed, 'GROK_MODEL');
        this.applyEnvValue(parsed, 'GROK_MODEL_ID');
      } catch (_error) {
        // Ignore parse errors to mirror dotenv's "quiet" mode.
      }
    }

    this.envLoaded = true;
  }

  private applyEnvValue(
    parsed: Record<string, string>,
    key: 'GROK_API_KEY' | 'GROK_MODEL' | 'GROK_MODEL_ID',
  ): void {
    const value = parsed[key];
    if (!value) {
      return;
    }

    if (key === 'GROK_API_KEY') {
      if (!process.env[key]) {
        process.env[key] = value;
      }
      return;
    }

    if (
      !process.env[key] ||
      process.env[key] === '' ||
      process.env[key] === DEFAULT_MODEL_ID
    ) {
      process.env[key] = value;
    }

    if (key === 'GROK_MODEL' && !process.env['GROK_MODEL_ID']) {
      process.env['GROK_MODEL_ID'] = value;
    } else if (key === 'GROK_MODEL_ID' && !process.env['GROK_MODEL']) {
      process.env['GROK_MODEL'] = value;
    }
  }

  private getEnvModel(): string | undefined {
    const primary = process.env['GROK_MODEL'];
    if (typeof primary === 'string' && primary.trim()) {
      return primary.trim();
    }
    const secondary = process.env['GROK_MODEL_ID'];
    if (typeof secondary === 'string' && secondary.trim()) {
      return secondary.trim();
    }
    return undefined;
  }

  private resolveLocations(): { packageRoot: string } {
    const currentDir = path.dirname(fileURLToPath(import.meta.url));
    const packageRoot = path.resolve(currentDir, '../../../../');
    return { packageRoot };
  }
}
