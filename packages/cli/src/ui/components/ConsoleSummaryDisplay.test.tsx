/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import { ConsoleSummaryDisplay } from './ConsoleSummaryDisplay.js';

describe('<ConsoleSummaryDisplay />', () => {
  it('renders provider-aware model label', () => {
    const { lastFrame } = render(
      <ConsoleSummaryDisplay
        errorCount={0}
        modelProviderId="google-genai"
        model="gemini-pro"
      />,
    );

    expect(lastFrame()).toContain('gemini · gemini-pro');
  });

  it('falls back to model when provider not supplied', () => {
    const { lastFrame } = render(
      <ConsoleSummaryDisplay errorCount={0} model="gemini-pro" />,
    );

    expect(lastFrame()).toContain('gemini-pro');
    expect(lastFrame()).not.toContain(' · ');
  });

  it('appends error counts when present', () => {
    const { lastFrame } = render(
      <ConsoleSummaryDisplay
        errorCount={2}
        model="grok-beta"
        modelProviderId="grok"
      />,
    );

    expect(lastFrame()).toContain('grok · grok-beta');
    expect(lastFrame()).toContain('2 errors');
  });
});
