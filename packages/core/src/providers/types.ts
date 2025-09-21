/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '../config/config.js';
import type {
  AuthType} from '../core/contentGenerator.js';
import {
  type ContentGenerator,
  type ContentGeneratorConfig,
} from '../core/contentGenerator.js';
import type { GeminiClient } from '../core/client.js';

export interface ModelProvider {
  /** Unique identifier for the provider (e.g., google-genai). */
  readonly id: string;

  /** Returns the default model identifier for this provider. */
  getDefaultModelId(): string;

  /** Returns true if the provider can service the provided model identifier. */
  isModelSupported(modelId: string): boolean;

  /**
   * Creates the content generator configuration used by the provider.
   */
  createContentGeneratorConfig(
    config: Config,
    authType: AuthType | undefined,
  ): ContentGeneratorConfig;

  /**
   * Instantiates a content generator for the provider using the supplied
   * configuration.
   */
  createContentGenerator(
    generatorConfig: ContentGeneratorConfig,
    config: Config,
    sessionId?: string,
  ): Promise<ContentGenerator>;

  /**
   * Instantiates a conversation client bound to the supplied config.
   */
  createConversationClient(config: Config): GeminiClient;
}

export interface ProviderRegistry {
  getDefaultProvider(): ModelProvider;
  getProvider(providerId: string): ModelProvider | undefined;
  listProviders(): readonly ModelProvider[];
}
