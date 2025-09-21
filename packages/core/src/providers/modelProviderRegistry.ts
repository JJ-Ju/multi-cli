/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { GoogleGenAIProvider } from './googleGenaiProvider.js';
import { GrokProvider } from './grokProvider.js';
import type { ModelProvider, ProviderRegistry } from './types.js';

/**
 * Lightweight registry that enumerates the model providers available to the
 * CLI. Today this is limited to a single Google provider, but abstraction here
 * allows future providers to be added without touching Config directly.
 */
export class ModelProviderRegistryImpl implements ProviderRegistry {
  private readonly providers = new Map<string, ModelProvider>();
  private readonly defaultProviderId: string;

  constructor() {
    const googleProvider = new GoogleGenAIProvider();
    const grokProvider = new GrokProvider();

    this.providers.set(googleProvider.id, googleProvider);
    this.providers.set(grokProvider.id, grokProvider);

    this.defaultProviderId = googleProvider.id;
  }

  getDefaultProvider(): ModelProvider {
    const provider = this.providers.get(this.defaultProviderId);
    if (!provider) {
      throw new Error('No default model provider registered.');
    }
    return provider;
  }

  getProvider(providerId: string): ModelProvider | undefined {
    return this.providers.get(providerId);
  }

  listProviders(): readonly ModelProvider[] {
    return Array.from(this.providers.values());
  }
}
