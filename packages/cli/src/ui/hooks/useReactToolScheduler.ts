/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  Config,
  ToolCallRequestInfo,
  ExecutingToolCall,
  ScheduledToolCall,
  ValidatingToolCall,
  WaitingToolCall,
  CompletedToolCall,
  CancelledToolCall,
  OutputUpdateHandler,
  AllToolCallsCompleteHandler,
  ToolCallsUpdateHandler,
  ToolCall,
  Status as CoreStatus,
  EditorType,
} from '@google/gemini-cli-core';
import { CoreToolScheduler } from '@google/gemini-cli-core';
import { useCallback, useState, useMemo } from 'react';
import type {
  HistoryItemToolGroup,
  IndividualToolCallDisplay,
} from '../types.js';
import { ToolCallStatus } from '../types.js';

type ResultDisplay = IndividualToolCallDisplay['resultDisplay'];

export type ScheduleFn = (
  request: ToolCallRequestInfo | ToolCallRequestInfo[],
  signal: AbortSignal,
) => void;
export type MarkToolsAsSubmittedFn = (callIds: string[]) => void;

export type TrackedScheduledToolCall = ScheduledToolCall & {
  responseSubmittedToGemini?: boolean;
};
export type TrackedValidatingToolCall = ValidatingToolCall & {
  responseSubmittedToGemini?: boolean;
};
export type TrackedWaitingToolCall = WaitingToolCall & {
  responseSubmittedToGemini?: boolean;
};
export type TrackedExecutingToolCall = ExecutingToolCall & {
  responseSubmittedToGemini?: boolean;
  pid?: number;
};
export type TrackedCompletedToolCall = CompletedToolCall & {
  responseSubmittedToGemini?: boolean;
};
export type TrackedCancelledToolCall = CancelledToolCall & {
  responseSubmittedToGemini?: boolean;
};

export type TrackedToolCall =
  | TrackedScheduledToolCall
  | TrackedValidatingToolCall
  | TrackedWaitingToolCall
  | TrackedExecutingToolCall
  | TrackedCompletedToolCall
  | TrackedCancelledToolCall;

export function useReactToolScheduler(
  onComplete: (tools: CompletedToolCall[]) => Promise<void>,
  config: Config,
  getPreferredEditor: () => EditorType | undefined,
  onEditorClose: () => void,
): [TrackedToolCall[], ScheduleFn, MarkToolsAsSubmittedFn] {
  const [toolCallsForDisplay, setToolCallsForDisplay] = useState<
    TrackedToolCall[]
  >([]);

  const outputUpdateHandler: OutputUpdateHandler = useCallback(
    (toolCallId, outputChunk) => {
      setToolCallsForDisplay((prevCalls) =>
        prevCalls.map((tc) => {
          if (tc.request.callId === toolCallId && tc.status === 'executing') {
            const executingTc = tc as TrackedExecutingToolCall;
            return { ...executingTc, liveOutput: outputChunk };
          }
          return tc;
        }),
      );
    },
    [],
  );

  const allToolCallsCompleteHandler: AllToolCallsCompleteHandler = useCallback(
    async (completedToolCalls) => {
      await onComplete(completedToolCalls);
    },
    [onComplete],
  );

  const toolCallsUpdateHandler: ToolCallsUpdateHandler = useCallback(
    (updatedCoreToolCalls: ToolCall[]) => {
      setToolCallsForDisplay((prevTrackedCalls) =>
        updatedCoreToolCalls.map((coreTc) => {
          const existingTrackedCall = prevTrackedCalls.find(
            (ptc) => ptc.request.callId === coreTc.request.callId,
          );
          // Start with the new core state, then layer on the existing UI state
          // to ensure UI-only properties like pid are preserved.
          const responseSubmittedToGemini =
            existingTrackedCall?.responseSubmittedToGemini ?? false;

          if (coreTc.status === 'executing') {
            return {
              ...coreTc,
              responseSubmittedToGemini,
              liveOutput: (existingTrackedCall as TrackedExecutingToolCall)
                ?.liveOutput,
              pid: (coreTc as ExecutingToolCall).pid,
            };
          }

          // For other statuses, explicitly set liveOutput and pid to undefined
          // to ensure they are not carried over from a previous executing state.
          return {
            ...coreTc,
            responseSubmittedToGemini,
            liveOutput: undefined,
            pid: undefined,
          };
        }),
      );
    },
    [setToolCallsForDisplay],
  );

  const scheduler = useMemo(
    () =>
      new CoreToolScheduler({
        outputUpdateHandler,
        onAllToolCallsComplete: allToolCallsCompleteHandler,
        onToolCallsUpdate: toolCallsUpdateHandler,
        getPreferredEditor,
        config,
        onEditorClose,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any),
    [
      config,
      outputUpdateHandler,
      allToolCallsCompleteHandler,
      toolCallsUpdateHandler,
      getPreferredEditor,
      onEditorClose,
    ],
  );

  const schedule: ScheduleFn = useCallback(
    (
      request: ToolCallRequestInfo | ToolCallRequestInfo[],
      signal: AbortSignal,
    ) => {
      void scheduler.schedule(request, signal);
    },
    [scheduler],
  );

  const markToolsAsSubmitted: MarkToolsAsSubmittedFn = useCallback(
    (callIdsToMark: string[]) => {
      setToolCallsForDisplay((prevCalls) =>
        prevCalls.map((tc) =>
          callIdsToMark.includes(tc.request.callId)
            ? { ...tc, responseSubmittedToGemini: true }
            : tc,
        ),
      );
    },
    [],
  );

  return [toolCallsForDisplay, schedule, markToolsAsSubmitted];
}

/**
 * Maps a CoreToolScheduler status to the UI's ToolCallStatus enum.
 */
function mapCoreStatusToDisplayStatus(coreStatus: CoreStatus): ToolCallStatus {
  switch (coreStatus) {
    case 'validating':
      return ToolCallStatus.Executing;
    case 'awaiting_approval':
      return ToolCallStatus.Confirming;
    case 'executing':
      return ToolCallStatus.Executing;
    case 'success':
      return ToolCallStatus.Success;
    case 'cancelled':
      return ToolCallStatus.Canceled;
    case 'error':
      return ToolCallStatus.Error;
    case 'scheduled':
      return ToolCallStatus.Pending;
    default: {
      const exhaustiveCheck: never = coreStatus;
      console.warn(`Unknown core status encountered: ${exhaustiveCheck}`);
      return ToolCallStatus.Error;
    }
  }
}

/**
 * Transforms `TrackedToolCall` objects into `HistoryItemToolGroup` objects for UI display.
 */
export function mapToDisplay(
  toolOrTools: TrackedToolCall[] | TrackedToolCall,
): HistoryItemToolGroup {
  const toolCalls = Array.isArray(toolOrTools) ? toolOrTools : [toolOrTools];

  const toolDisplays = toolCalls.map(
    (trackedCall): IndividualToolCallDisplay => {
      let displayName: string;
      let description: string;
      let renderOutputAsMarkdown = false;

      if (trackedCall.status === 'error') {
        displayName =
          trackedCall.tool === undefined
            ? trackedCall.request.name
            : trackedCall.tool.displayName;
        description = JSON.stringify(trackedCall.request.args);
      } else {
        displayName = trackedCall.tool.displayName;
        description = trackedCall.invocation.getDescription();
        renderOutputAsMarkdown = trackedCall.tool.isOutputMarkdown;
      }

      const baseDisplayProperties: Omit<
        IndividualToolCallDisplay,
        'status' | 'resultDisplay' | 'confirmationDetails'
      > = {
        callId: trackedCall.request.callId,
        name: displayName,
        description,
        renderOutputAsMarkdown,
      };

      switch (trackedCall.status) {
        case 'success': {
          const successDisplay = formatToolResultDisplay(
            trackedCall.response.resultDisplay,
          );
          return {
            ...baseDisplayProperties,
            status: mapCoreStatusToDisplayStatus(trackedCall.status),
            renderOutputAsMarkdown:
              baseDisplayProperties.renderOutputAsMarkdown ||
              successDisplay.preferMarkdown,
            resultDisplay: successDisplay.display,
            confirmationDetails: undefined,
            outputFile: trackedCall.response.outputFile,
          };
        }
        case 'error': {
          const errorDisplay = formatToolResultDisplay(
            trackedCall.response.resultDisplay,
          );
          return {
            ...baseDisplayProperties,
            status: mapCoreStatusToDisplayStatus(trackedCall.status),
            renderOutputAsMarkdown:
              baseDisplayProperties.renderOutputAsMarkdown ||
              errorDisplay.preferMarkdown,
            resultDisplay: errorDisplay.display,
            confirmationDetails: undefined,
          };
        }
        case 'cancelled': {
          const cancelledDisplay = formatToolResultDisplay(
            trackedCall.response.resultDisplay,
          );
          return {
            ...baseDisplayProperties,
            status: mapCoreStatusToDisplayStatus(trackedCall.status),
            renderOutputAsMarkdown:
              baseDisplayProperties.renderOutputAsMarkdown ||
              cancelledDisplay.preferMarkdown,
            resultDisplay: cancelledDisplay.display,
            confirmationDetails: undefined,
          };
        }
        case 'awaiting_approval':
          return {
            ...baseDisplayProperties,
            status: mapCoreStatusToDisplayStatus(trackedCall.status),
            resultDisplay: undefined,
            confirmationDetails: trackedCall.confirmationDetails,
          };
        case 'executing':
          return {
            ...baseDisplayProperties,
            status: mapCoreStatusToDisplayStatus(trackedCall.status),
            resultDisplay:
              (trackedCall as TrackedExecutingToolCall).liveOutput ?? undefined,
            confirmationDetails: undefined,
            ptyId: (trackedCall as TrackedExecutingToolCall).pid,
          };
        case 'validating': // Fallthrough
        case 'scheduled':
          return {
            ...baseDisplayProperties,
            status: mapCoreStatusToDisplayStatus(trackedCall.status),
            resultDisplay: undefined,
            confirmationDetails: undefined,
          };
        default: {
          const exhaustiveCheck: never = trackedCall;
          return {
            callId: (exhaustiveCheck as TrackedToolCall).request.callId,
            name: 'Unknown Tool',
            description: 'Encountered an unknown tool call state.',
            status: ToolCallStatus.Error,
            resultDisplay: 'Unknown tool call state',
            confirmationDetails: undefined,
            renderOutputAsMarkdown: false,
          };
        }
      }
    },
  );

  return {
    type: 'tool_group',
    tools: toolDisplays,
  };
}

function formatToolResultDisplay(resultDisplay: ResultDisplay): {
  display: ResultDisplay;
  preferMarkdown: boolean;
} {
  if (typeof resultDisplay !== 'string') {
    return { display: resultDisplay, preferMarkdown: false };
  }

  const jsonFormatted = tryFormatJson(resultDisplay);
  if (jsonFormatted) {
    return { display: jsonFormatted, preferMarkdown: true };
  }

  const streamFormatted = formatStreamSections(resultDisplay);
  if (streamFormatted) {
    return { display: streamFormatted, preferMarkdown: true };
  }

  return { display: resultDisplay, preferMarkdown: false };
}

function tryFormatJson(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed.startsWith('```')) {
    return undefined;
  }
  const startsWithStructure =
    trimmed.startsWith('{') || trimmed.startsWith('[');
  if (!startsWithStructure) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(trimmed);
    return `\`\`\`json\n${JSON.stringify(parsed, null, 2)}\n\`\`\``;
  } catch {
    return undefined;
  }
}

function formatStreamSections(value: string): string | undefined {
  if (!value) {
    return undefined;
  }
  if (value.includes('```')) {
    return undefined;
  }

  const lower = value.toLowerCase();
  if (!lower.includes('stdout') && !lower.includes('stderr')) {
    return undefined;
  }

  const stdout: string[] = [];
  const stderr: string[] = [];
  const other: string[] = [];
  let current: 'stdout' | 'stderr' | 'other' = 'other';

  for (const line of value.split(/\r?\n/)) {
    const stdoutMatch = line.match(/^\s*stdout\s*:\s*(.*)$/i);
    if (stdoutMatch) {
      current = 'stdout';
      if (stdoutMatch[1]) {
        stdout.push(stdoutMatch[1]);
      }
      continue;
    }
    const stderrMatch = line.match(/^\s*stderr\s*:\s*(.*)$/i);
    if (stderrMatch) {
      current = 'stderr';
      if (stderrMatch[1]) {
        stderr.push(stderrMatch[1]);
      }
      continue;
    }

    switch (current) {
      case 'stdout':
        stdout.push(line);
        break;
      case 'stderr':
        stderr.push(line);
        break;
      default:
        other.push(line);
    }
  }

  if (stdout.length === 0 && stderr.length === 0) {
    return undefined;
  }

  const sections: string[] = [];
  const otherText = other.join('\n').trim();
  if (otherText) {
    sections.push(otherText);
  }

  if (stdout.length > 0) {
    const text = stdout.join('\n').trim() || '(empty)';
    sections.push(`**stdout**\n\`\`\`\n${text}\n\`\`\``);
  }

  if (stderr.length > 0) {
    const text = stderr.join('\n').trim() || '(empty)';
    sections.push(`**stderr**\n\`\`\`\n${text}\n\`\`\``);
  }

  return sections.join('\n\n');
}
