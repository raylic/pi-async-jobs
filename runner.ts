/**
 * Process spawning and process-tree termination.
 *
 * Deliberately ignores any turn-scoped AbortSignal: a job must outlive the
 * agent turn that started it. Callers cancel through `RunningProcess.kill()`.
 */

import { spawn, type ChildProcess } from "node:child_process";
import type { ExitInfo } from "./types.ts";

export interface ProcessDataHandlers {
  onData?: (chunk: Buffer, stream: "stdout" | "stderr") => void;
}

export interface StartProcessOptions {
  command: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

export interface RunningProcess {
  readonly pid: number;
  /** POSIX process-group id; equals pid because the child is detached. */
  readonly pgid: number;
  readonly exited: Promise<ExitInfo>;
  /** Kill the whole process tree: SIGTERM, then SIGKILL after the grace period. Idempotent. */
  kill(options?: { graceMs?: number }): Promise<void>;
  readonly timedOut: boolean;
}

export interface ProcessRunnerOptions {
  /** Default SIGTERM -> SIGKILL grace period. */
  graceMs?: number;
  /** Injectable for tests; defaults to the host platform. */
  platform?: NodeJS.Platform;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class RunningProcessImpl implements RunningProcess {
  readonly exited: Promise<ExitInfo>;
  private readonly child: ChildProcess;
  private readonly runner: ProcessRunner;
  private exitedInfo: ExitInfo | undefined;
  private killPromise: Promise<void> | undefined;
  private timeoutHandle: NodeJS.Timeout | undefined;
  private _timedOut = false;

  constructor(child: ChildProcess, runner: ProcessRunner, timeoutMs: number | undefined) {
    this.child = child;
    this.runner = runner;
    this.exited = new Promise<ExitInfo>((resolve) => {
      const settle = (info: ExitInfo) => {
        if (this.exitedInfo) return;
        this.exitedInfo = info;
        if (this.timeoutHandle) clearTimeout(this.timeoutHandle);
        this.runner.forget(this);
        resolve(info);
      };
      this.child.once("error", (error: Error) => {
        settle({ exitCode: null, signal: null, error: error.message, timedOut: this._timedOut });
      });
      this.child.once("close", (code: number | null, signal: NodeJS.Signals | null) => {
        settle({ exitCode: code, signal: signal ?? null, timedOut: this._timedOut });
      });
    });

    if (timeoutMs !== undefined && timeoutMs > 0) {
      this.timeoutHandle = setTimeout(() => {
        this._timedOut = true;
        void this.kill();
      }, timeoutMs);
      // A job must not keep the pi process alive on its own.
      this.timeoutHandle.unref?.();
    }
  }

  get pid(): number {
    return this.child.pid ?? -1;
  }

  get pgid(): number {
    return this.child.pid ?? -1;
  }

  get timedOut(): boolean {
    return this._timedOut;
  }

  kill(options: { graceMs?: number } = {}): Promise<void> {
    if (this.killPromise) return this.killPromise;
    this.killPromise = (async () => {
      if (this.exitedInfo) return;
      const pid = this.child.pid;
      if (pid === undefined) return;
      const graceMs = options.graceMs ?? this.runner.graceMs;
      this.runner.killTree(pid, "SIGTERM");
      const raced = await Promise.race([this.exited.then(() => true), delay(graceMs).then(() => false)]);
      if (!raced) {
        this.runner.killTree(pid, "SIGKILL");
        await this.exited;
      }
    })();
    return this.killPromise;
  }
}

export class ProcessRunner {
  readonly graceMs: number;
  private readonly platform: NodeJS.Platform;
  private readonly children = new Set<RunningProcessImpl>();

  constructor(options: ProcessRunnerOptions = {}) {
    this.graceMs = options.graceMs ?? 5000;
    this.platform = options.platform ?? process.platform;
  }

  start(options: StartProcessOptions, handlers: ProcessDataHandlers = {}): RunningProcess {
    const child = spawn(options.command, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      shell: true,
      // On POSIX a detached child becomes its own process-group leader, so we
      // can signal the whole tree with `process.kill(-pid)`.
      detached: this.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });

    if (handlers.onData) {
      child.stdout?.on("data", (chunk: Buffer) => handlers.onData?.(chunk, "stdout"));
      child.stderr?.on("data", (chunk: Buffer) => handlers.onData?.(chunk, "stderr"));
    } else {
      child.stdout?.resume();
      child.stderr?.resume();
    }

    const process_ = new RunningProcessImpl(child, this, options.timeoutMs);
    this.children.add(process_);
    return process_;
  }

  /** Kill every process tree this runner started. */
  async killAll(graceMs?: number): Promise<void> {
    const running = [...this.children];
    await Promise.all(running.map((child) => child.kill({ graceMs })));
  }

  get runningCount(): number {
    return this.children.size;
  }

  /** @internal */
  forget(child: RunningProcessImpl): void {
    this.children.delete(child);
  }

  /** @internal */
  killTree(pid: number, signal: NodeJS.Signals): void {
    if (this.platform === "win32") {
      try {
        spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" }).unref();
      } catch {
        // Best effort: the tree may already be gone.
      }
      return;
    }
    try {
      process.kill(-pid, signal);
    } catch {
      try {
        process.kill(pid, signal);
      } catch {
        // Best effort: the tree may already be gone.
      }
    }
  }
}
