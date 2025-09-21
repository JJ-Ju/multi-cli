/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { mapToDisplay } from './useReactToolScheduler.js';
import type { TrackedToolCall } from './useReactToolScheduler.js';

type SupportedStatuses = Extract<
  TrackedToolCall['status'],
  | 'success'
  | 'cancelled'
  | 'awaiting_approval'
  | 'executing'
  | 'validating'
  | 'scheduled'
>;

function createTrackedCall(
  status: SupportedStatuses,
  resultDisplay: string,
): TrackedToolCall {
  return {
    status,
    request: {
      callId: 'call-1',
      name: 'run_shell_command',
      args: {},
      isClientInitiated: false,
      prompt_id: 'prompt-1',
    },
    tool: {
      displayName: 'Shell',
      isOutputMarkdown: false,
    } as unknown,
    invocation: {
      getDescription: () => 'Shell command',
    } as unknown,
    responseSubmittedToGemini: false,
    response: {
      callId: 'call-1',
      responseParts: [],
      resultDisplay,
      error: undefined,
      errorType: undefined,
    },
  } as unknown as TrackedToolCall;
}

describe('mapToDisplay', () => {
  it('prettifies JSON tool output', () => {
    const toolGroup = mapToDisplay([
      createTrackedCall('success', '{"foo":"bar"}') as TrackedToolCall,
    ]);

    const tool = toolGroup.tools[0];
    expect(typeof tool.resultDisplay).toBe('string');
    expect(tool.renderOutputAsMarkdown).toBe(true);
    expect(tool.resultDisplay as string).toContain('```json');
    expect(tool.resultDisplay as string).toContain('\n  "foo": "bar"\n');
  });

  it('formats stdout and stderr sections into code blocks', () => {
    const rawOutput = [
      'Command: echo',
      'stdout: hello world',
      'line two',
      'stderr: something went wrong',
    ].join('\n');

    const toolGroup = mapToDisplay([
      createTrackedCall('success', rawOutput) as TrackedToolCall,
    ]);

    const tool = toolGroup.tools[0];
    expect(tool.renderOutputAsMarkdown).toBe(true);
    const display = tool.resultDisplay as string;
    expect(display).toContain('**stdout**');
    expect(display).toContain('hello world');
    expect(display).toContain('line two');
    expect(display).toContain('**stderr**');
    expect(display).toContain('something went wrong');
  });
});
