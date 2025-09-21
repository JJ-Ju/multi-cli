/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  AuthType} from '../core/contentGenerator.js';
import {
  createContentGenerator,
  createContentGeneratorConfig,
  type ContentGenerator,
  type ContentGeneratorConfig,
} from '../core/contentGenerator.js';
import { GeminiClient } from '../core/client.js';
import type { Config } from '../config/config.js';
import { DEFAULT_GEMINI_MODEL } from '../config/models.js';
import type { ModelProvider } from './types.js';

/**
 * Default provider implementation that maintains the existing Google Gemini
 * behaviour from before provider modularization.
 */
export class GoogleGenAIProvider implements ModelProvider {
  readonly id = 'google-genai';

  getDefaultModelId(): string {
    return DEFAULT_GEMINI_MODEL;
  }

  isModelSupported(modelId: string): boolean {
    if (modelId === 'auto') {
      return true;
    }
    return modelId.startsWith('gemini-');
  }

  createContentGeneratorConfig(
    config: Config,
    authType: AuthType | undefined,
  ): ContentGeneratorConfig {
    return createContentGeneratorConfig(config, authType);
  }

  async createContentGenerator(
    generatorConfig: ContentGeneratorConfig,
    config: Config,
    sessionId?: string,
  ): Promise<ContentGenerator> {
    return createContentGenerator(generatorConfig, config, sessionId);
  }

  createConversationClient(config: Config): GeminiClient {
    return new GeminiClient(config);
  }
}
