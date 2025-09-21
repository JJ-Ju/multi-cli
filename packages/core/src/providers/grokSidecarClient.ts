/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import {
  spawn,
  spawnSync,
  type ChildProcessWithoutNullStreams,
} from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createInterface } from 'node:readline';
import path from 'node:path';

import { logGrokDebug } from './grokDebugLogger.js';

interface PendingRequest<T = unknown> {
  resolve: (value: T) => void;
  reject: (reason: Error) => void;
  stream?: EventEmitter;
}

interface InitializePayload {
  apiKey?: string;
  api_key?: string;
  model?: string;
  pythonPath?: string;
}

export interface ChatRequestPayload {
  sessionId: string;
  messages: Array<Record<string, unknown>>;
  tools: Array<Record<string, unknown>>;
  options?: Record<string, unknown>;
}

export interface ChatResponsePayload {
  message: Record<string, unknown>;
  usage?: Record<string, unknown>;
}

export interface ValidateResponsePayload {
  passed: boolean;
  rawResponse: string;
}

interface CallWithStreamResult<T> {
  result: Promise<T>;
  stream: EventEmitter;
}

export class GrokSidecarClient {
  private pythonExecutable?: string;
  private child?: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<string, PendingRequest>();
  private initialized = false;

  constructor(private readonly workingDir: string) {
    logGrokDebug('grok.sidecar.client.created', { workingDir });
  }

  async ensureInitialised(payload: InitializePayload): Promise<void> {
    if (this.initialized) {
      return;
    }
    if (!payload.apiKey) {
      throw new Error(
        'GROK_API_KEY is required to use the Grok model provider.',
      );
    }

    logGrokDebug('grok.sidecar.initialize.begin', {
      model: payload.model,
      pythonPath: payload.pythonPath,
    });
    const result = await this.call('initialize', payload);
    if (result && typeof result === 'object') {
      this.initialized = true;
      logGrokDebug('grok.sidecar.initialize.success');
    }
  }

  async registerTools(tools: Array<Record<string, unknown>>): Promise<void> {
    if (!tools.length) return;
    logGrokDebug('grok.sidecar.registerTools', { toolCount: tools.length });
    await this.call('registerTools', { tools });
  }

  async validate(prompt: string): Promise<ValidateResponsePayload> {
    logGrokDebug('grok.sidecar.validate', { prompt });
    const response = (await this.call('validate', { prompt })) as
      | ValidateResponsePayload
      | undefined;
    if (!response) {
      return { passed: false, rawResponse: '' };
    }
    return response;
  }

  chatStream(
    payload: ChatRequestPayload,
  ): CallWithStreamResult<ChatResponsePayload> {
    return this.callWithStream(
      'chat',
      payload,
    ) as CallWithStreamResult<ChatResponsePayload>;
  }

  async chat(payload: ChatRequestPayload): Promise<ChatResponsePayload> {
    const { result } = this.callWithStream('chat', payload);
    const response = (await result) as ChatResponsePayload | undefined;
    if (!response) {
      throw new Error('Grok sidecar returned empty response.');
    }
    return response;
  }

  async toolResult(
    callId: string,
    content: unknown[],
    isError: boolean,
  ): Promise<void> {
    logGrokDebug('grok.sidecar.toolResult', {
      callId,
      isError,
      partCount: content.length,
    });
    await this.call('toolResult', { callId, content, isError });
  }

  async shutdown(): Promise<void> {
    try {
      await this.call('shutdown', {});
    } catch (_error) {
      // Ignore errors during shutdown.
    }
    this.dispose();
  }

  dispose(): void {
    this.initialized = false;
    if (this.child && !this.child.killed) {
      logGrokDebug('grok.sidecar.dispose.killing', {
        pid: this.child.pid,
      });
      this.child.kill('SIGTERM');
    }
    this.child = undefined;
    this.pending.forEach(({ reject }) =>
      reject(new Error('Sidecar process terminated')),
    );
    this.pending.clear();
  }

  // ---------------------------------------------------------------------------
  private ensureProcess(): ChildProcessWithoutNullStreams {
    if (this.child) {
      return this.child;
    }

    const providersDir = path.resolve(this.workingDir, 'providers');
    const env = { ...process.env };
    env['PYTHONPATH'] = env['PYTHONPATH']
      ? `${providersDir}${path.delimiter}${env['PYTHONPATH']}`
      : providersDir;

    const pythonExecutable =
      this.pythonExecutable ?? this.resolvePythonExecutable();
    this.pythonExecutable = pythonExecutable;

    logGrokDebug('grok.sidecar.spawn.begin', {
      pythonExecutable,
      workingDir: this.workingDir,
    });
    const child = spawn(pythonExecutable, ['-m', 'grok_sidecar'], {
      cwd: this.workingDir,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    logGrokDebug('grok.sidecar.spawn.success', {
      pid: child.pid,
    });

    const rl = createInterface({ input: child.stdout });
    rl.on('line', (line) => this.handleLine(line));

    child.stderr.on('data', (data) => {
      const message = data?.toString()?.trim();
      if (message) {
        logGrokDebug('grok.sidecar.stderr', { message });
      }
    });

    child.once('exit', (code, signal) => {
      logGrokDebug('grok.sidecar.exit', { code, signal });
      const reason =
        signal != null
          ? new Error(`Sidecar exited due to signal ${signal}`)
          : new Error(`Sidecar exited with code ${code}`);
      this.pending.forEach(({ reject }) => reject(reason));
      this.pending.clear();
      this.child = undefined;
      this.initialized = false;
    });

    this.child = child;
    return child;
  }

  private resolvePythonExecutable(): string {
    const candidates = [
      process.env['GROK_PYTHON_BIN'],
      process.env['PYTHON'],
      'python',
      'python3',
    ].filter(
      (candidate): candidate is string =>
        !!candidate && candidate.trim().length > 0,
    );

    for (const candidate of candidates) {
      const result = spawnSync(candidate, ['--version'], {
        stdio: 'ignore',
      });

      if (!result.error && result.status === 0) {
        logGrokDebug('grok.sidecar.python.detected', { candidate });
        return candidate;
      }
    }

    throw new Error(
      'Unable to locate a Python runtime. Set GROK_PYTHON_BIN to a Python 3.10+ executable.',
    );
  }

  private async call(action: string, payload: unknown): Promise<unknown> {
    const { result } = this.callWithStream(action, payload);
    return result;
  }

  private callWithStream(
    action: string,
    payload: unknown,
  ): CallWithStreamResult<unknown> {
    const child = this.ensureProcess();
    const requestId = randomUUID();

    const stream = new EventEmitter();

    const resultPromise = new Promise<unknown>((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject, stream });
    });

    const message = {
      type: 'request',
      requestId,
      action,
      payload,
    };

    logGrokDebug('grok.sidecar.request.write', {
      requestId,
      action,
      summary: summarisePayload(action, payload),
    });

    child.stdin.write(`${JSON.stringify(message)}\n`);
    const finalize = () => {
      stream.emit('end');
    };
    resultPromise.then(finalize).catch((error) => {
      stream.emit(
        'error',
        error instanceof Error ? error : new Error(String(error)),
      );
      finalize();
    });

    return { result: resultPromise, stream };
  }

  private handleLine(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch (_error) {
      logGrokDebug('grok.sidecar.parseError', { line });
      return;
    }

    if (!isSidecarMessage(message)) {
      logGrokDebug('grok.sidecar.message.invalid', { message });
      return;
    }

    logGrokDebug('grok.sidecar.message.received', {
      requestId: message.requestId,
      type: message.type,
    });

    const requestId: string | undefined = message.requestId;
    const pending = requestId ? this.pending.get(requestId) : undefined;

    switch (message.type) {
      case 'event':
        pending?.stream?.emit('event', message.payload);
        break;
      case 'result':
        if (pending) {
          this.pending.delete(requestId!);
          pending.resolve(message.payload);
        }
        break;
      case 'error':
        if (pending) {
          this.pending.delete(requestId!);
          const error = new Error(
            message.error?.message || 'Unknown sidecar error',
          );
          pending.reject(error);
        }
        break;
      default:
        logGrokDebug('grok.sidecar.message.unknown', { message });
    }
  }
}

function summarisePayload(
  action: string,
  payload: unknown,
): Record<string, unknown> | undefined {
  if (!payload || typeof payload !== 'object') {
    return undefined;
  }

  if (action === 'chat') {
    const chatPayload = payload as ChatRequestPayload;
    return {
      messageCount: chatPayload.messages?.length,
      toolCount: chatPayload.tools?.length,
    };
  }

  if (action === 'initialize') {
    const init = payload as InitializePayload;
    return {
      hasApiKey: !!init.apiKey || !!init.api_key,
      model: init.model,
    };
  }

  return undefined;
}

type SidecarMessage = {
  requestId?: string;
  type?: string;
  payload?: unknown;
  error?: { message?: string };
};

function isSidecarMessage(value: unknown): value is SidecarMessage {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const candidate = value as SidecarMessage;
  return typeof candidate.type === 'string';
}
