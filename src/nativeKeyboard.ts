import * as cp from 'child_process';
import * as vscode from 'vscode';

export interface NativeKeyboardOptions {
  binary: string;
  hotkey: string;
  onKeyDown: () => void;
  onKeyUp: () => void;
  onError?: (err: string) => void;
}

interface HookEvent {
  event: 'ready' | 'keydown' | 'keyup';
  vk: number;
  mods: number;
}

export class NativeKeyboard implements vscode.Disposable {
  private proc: cp.ChildProcessWithoutNullStreams | undefined;
  private buffer = '';
  private readyResolve: (() => void) | undefined;
  private readyReject: ((err: Error) => void) | undefined;

  constructor(private readonly opts: NativeKeyboardOptions) {}

  async start(): Promise<void> {
    if (this.proc) { return; }
    const proc = cp.spawn(this.opts.binary, ['--hotkey', this.opts.hotkey], {
      windowsHide: true,
    });
    this.proc = proc;
    proc.stdout.setEncoding('utf8');
    proc.stderr.setEncoding('utf8');
    proc.stdout.on('data', (chunk: string) => this.onStdout(chunk));
    proc.stderr.on('data', (chunk: string) => {
      this.opts.onError?.(`hold-to-talk stderr: ${chunk.trim()}`);
    });
    proc.on('error', (err) => {
      this.opts.onError?.(`hold-to-talk failed to start: ${err.message}`);
      this.readyReject?.(err);
      this.proc = undefined;
    });
    proc.on('exit', (code, signal) => {
      this.proc = undefined;
      if (code !== 0 && code !== null) {
        this.opts.onError?.(`hold-to-talk exited with code ${code}${signal ? ` (${signal})` : ''}`);
      }
    });

    await new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
      setTimeout(() => reject(new Error('hold-to-talk did not emit ready within 3s')), 3000);
    });
  }

  dispose(): void {
    if (!this.proc) { return; }
    try { this.proc.kill(); } catch { /* ignore */ }
    this.proc = undefined;
  }

  private onStdout(chunk: string): void {
    this.buffer += chunk;
    let nl: number;
    while ((nl = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) { continue; }
      let evt: HookEvent;
      try { evt = JSON.parse(line); }
      catch { continue; }
      this.handleEvent(evt);
    }
  }

  private handleEvent(evt: HookEvent): void {
    switch (evt.event) {
      case 'ready':
        this.readyResolve?.();
        this.readyResolve = undefined;
        this.readyReject = undefined;
        return;
      case 'keydown':
        this.opts.onKeyDown();
        return;
      case 'keyup':
        this.opts.onKeyUp();
        return;
    }
  }
}
