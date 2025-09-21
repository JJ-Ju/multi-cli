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
import {
  type ModelToolingSupport,
  type ModelToolingSupportDependencies,
} from './modelToolingSupport.js';
import { GrokContentGenerator } from './grokContentGenerator.js';
import { GrokToolingSupport } from './grokToolingSupport.js';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as dotenv from 'dotenv';

const DEFAULT_MODEL_ID = 'grok-4-fast-reasoning';
const GROK_LEGACY_ALIASES = new Set([
  'grok-beta',
  'grok 1.5',
  'grok-1.5',
  'grok1.5',
  'grok_v1.5',
]);

export class GrokProvider implements ModelProvider {
  readonly id = 'grok';

  private sidecar?: GrokSidecarClient;
  private envLoaded = false;

  getDefaultModelId(): string {
    this.ensureEnvironment();
    return this.getEnvModel() ?? DEFAULT_MODEL_ID;
  }

  isModelSupported(modelId: string): boolean {
    return this.normalizeModel(modelId) !== undefined;
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
    const modelId = this.resolveModel(config);
    return new GrokContentGenerator(config, sidecar, {
      apiKey: generatorConfig.apiKey || '',
      model: modelId,
      pythonPath: process.env['GROK_PYTHON_BIN'],
    });
  }

  createConversationClient(config: Config): GeminiClient {
    return new GeminiClient(config);
  }

  createToolingSupport(
    config: Config,
    _dependencies: ModelToolingSupportDependencies,
  ): ModelToolingSupport {
    this.ensureEnvironment();
    const sidecar = this.ensureSidecar();
    const modelId = this.resolveModel(config);
    return new GrokToolingSupport(sidecar, {
      apiKey: process.env['GROK_API_KEY'] || '',
      model: modelId,
      pythonPath: process.env['GROK_PYTHON_BIN'],
    });
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

    if (!process.env[key]) {
      process.env[key] = value;
    }
  }

  private resolveModel(config?: Config): string {
    const configModel = this.normalizeModel(
      typeof (config as { getModel?: () => string | undefined })?.getModel ===
        'function'
        ? (config as { getModel: () => string | undefined }).getModel()
        : undefined,
    );
    if (configModel) {
      return configModel;
    }

    const envModel = this.getEnvModel();
    if (envModel) {
      return envModel;
    }

    return DEFAULT_MODEL_ID;
  }

  private normalizeModel(value?: string | null): string | undefined {
    if (typeof value !== 'string') {
      return undefined;
    }
    const trimmed = value.trim();
    if (!trimmed) {
      return undefined;
    }
    const lower = trimmed.toLowerCase();
    if (lower === 'auto') {
      return DEFAULT_MODEL_ID;
    }
    if (GROK_LEGACY_ALIASES.has(lower)) {
      return DEFAULT_MODEL_ID;
    }
    if (!lower.startsWith('grok')) {
      return undefined;
    }
    return trimmed;
  }

  private getEnvModel(): string | undefined {
    const envValue = process.env['GROK_MODEL'] ?? process.env['GROK_MODEL_ID'];
    return this.normalizeModel(envValue);
  }

  private resolveLocations(): { packageRoot: string } {
    const currentDir = path.dirname(fileURLToPath(import.meta.url));
    const packageRoot = path.resolve(currentDir, '../../../../../');
    return { packageRoot };
  }
}
