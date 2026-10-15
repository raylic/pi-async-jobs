/**
 * Composes the registry, the process runner and the output buffers into the
 * operations the tools need. Holds no pi-specific types, so it can be driven
 * by a fake runner in unit tests.
 */

import { OutputBuffer } from "./buffer.ts";
import type { JobConfig } from "./config.ts";
import type { JobRegistry } from "./registry.ts";
import type { ProcessRunner, RunningProcess } from "./runner.ts";
import type {
  CancelResult,
  ExitInfo,
  JobEntry,
  JobRecord,
  JobSpec,
  OutputSnapshot,
  StartResult,
} from "./types.ts";

export type CancelOrigin = "agent" | "user";

export interface JobServiceDeps {
  registry: JobRegistry;
  runner: ProcessRunner;
  config: JobConfig;
  now?: () => number;
  /** Called after a job settles, so the wake scheduler can decide what to do. */
  onSettled?: (jobId: string) => void;
  idPrefix?: string;
}

export interface JobView {
  record: JobRecord;
  snapshot: OutputSnapshot;
}

/** An already-running process handed over by the bash timeout takeover. */
export interface AdoptedJobInput {
  spec: JobSpec;
  buffer: OutputBuffer;
  handle: RunningProcess;
  /** When the process was actually started, which precedes the adoption. */
  startedAt: number;
}

export function clampText(text: string, maxBytes: number): string {
  const buffer = Buffer.from(text, "utf-8");
  if (buffer.length <= maxBytes) return text;
  // Back off to a character boundary so we never emit a broken UTF-8 tail.
  let end = maxBytes;
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end--;
  return `${buffer.subarray(0, end).toString("utf-8")}…`;
}

export class JobService {
  private counter = 0;
  private readonly buffers = new Map<string, OutputBuffer>();
  private readonly handles = new Map<string, RunningProcess>();
  private readonly deps: JobServiceDeps;
  private readonly now: () => number;

  constructor(deps: JobServiceDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
  }

  start(spec: JobSpec): StartResult {
    if (this.deps.registry.runningCount() >= this.deps.config.maxConcurrent) {
      return {
        ok: false,
        reason: `并发上限已达 ${this.deps.config.maxConcurrent}，请等某个任务结束或先 job_cancel 掉一个`,
      };
    }

    const buffer = new OutputBuffer({
      maxLines: this.deps.config.maxLines,
      maxBytes: this.deps.config.maxBytes,
    });

    let handle: RunningProcess;
    try {
      handle = this.deps.runner.start(
        { command: spec.command, cwd: spec.cwd, timeoutMs: spec.timeoutMs ?? this.deps.config.defaultTimeoutMs },
        { onData: (chunk) => buffer.append(chunk) },
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return { ok: false, reason: `无法启动进程: ${reason}` };
    }

    return { ok: true, entry: this.track(spec, buffer, handle, this.now()) };
  }

  /**
   * Register a process that is already running (the bash timeout takeover).
   * The concurrency gate is deliberately bypassed: refusing would mean killing a
   * command the user asked for, and the process exists either way.
   */
  adopt(input: AdoptedJobInput): JobEntry {
    return this.track(input.spec, input.buffer, input.handle, input.startedAt);
  }

  private track(spec: JobSpec, buffer: OutputBuffer, handle: RunningProcess, startedAt: number): JobEntry {
    const id = `${this.deps.idPrefix ?? "j"}${++this.counter}`;
    const record: JobRecord = {
      id,
      command: spec.command,
      cwd: spec.cwd,
      onDone: clampText(spec.onDone, this.deps.config.onDoneMaxBytes),
      label: spec.label,
      pid: handle.pid,
      startedAt,
      status: "running",
      announced: false,
    };

    const entry: JobEntry = {
      record,
      snapshot: () => buffer.snapshot(),
      cancel: () => handle.kill({ graceMs: this.deps.config.sigtermGraceMs }),
    };

    this.deps.registry.add(entry);
    this.buffers.set(id, buffer);
    this.handles.set(id, handle);

    void handle.exited.then(async (info: ExitInfo) => {
      buffer.finish();
      const settled = this.deps.registry.settle(id, {
        status: info.exitCode === 0 ? "exited" : "failed",
        exitCode: info.exitCode,
        signal: info.signal,
        timedOut: info.timedOut,
      });
      await buffer.close();
      this.handles.delete(id);
      if (settled) this.deps.onSettled?.(id);
    });

    return entry;
  }

  view(id: string): JobView | undefined {
    const entry = this.deps.registry.get(id);
    if (!entry) return undefined;
    return { record: entry.record, snapshot: entry.snapshot() };
  }

  list(): JobRecord[] {
    return this.deps.registry
      .all()
      .map((entry) => entry.record)
      .sort((a, b) => a.startedAt - b.startedAt);
  }

  /**
   * Cancel a running job. Idempotent: cancelling a settled job reports its
   * current state instead of failing.
   *
   * `origin` decides whether the model already knows: a cancel the model issued
   * is marked as delivered immediately (the tool result said so), while a
   * user-issued cancel flows through the normal completion path.
   */
  async cancel(id: string, origin: CancelOrigin = "agent"): Promise<CancelResult> {
    const entry = this.deps.registry.get(id);
    if (!entry) return { ok: false, reason: `未知的任务 id: ${id}` };
    if (entry.record.status !== "running") return { ok: true, record: entry.record };

    this.deps.registry.settle(id, { status: "cancelled", exitCode: null, signal: "SIGTERM" });
    if (origin === "agent") this.deps.registry.announce(id);

    await entry.cancel();
    this.handles.delete(id);

    if (origin === "user") this.deps.onSettled?.(id);
    return { ok: true, record: entry.record };
  }

  /** Kill every job and delete its spill file. Called from session_shutdown. */
  async shutdown(): Promise<void> {
    await this.deps.runner.killAll(this.deps.config.sigtermGraceMs);
    await Promise.all([...this.buffers.values()].map((buffer) => buffer.dispose()));
    this.buffers.clear();
    this.handles.clear();
    this.deps.registry.clear();
  }
}
