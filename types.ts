/**
 * Shared types for the async-jobs extension.
 *
 * This module is deliberately dependency-free: nothing under `core/` may import
 * `@earendil-works/pi-coding-agent` or `typebox`. Only `index.ts` (the
 * composition root) touches the pi runtime, which keeps every other module
 * unit-testable with plain `node --test`.
 */

export type JobStatus = "running" | "exited" | "failed" | "cancelled";

export type TerminalStatus = Exclude<JobStatus, "running">;

/** What the model asked for. */
export interface JobSpec {
  command: string;
  cwd: string;
  /**
   * The intent: what the caller will do once the job finishes. This is the
   * stand-in for a JavaScript continuation — pi has no stack frame to resume,
   * so the completion message replays this text verbatim.
   */
  onDone: string;
  label?: string;
  timeoutMs?: number;
}

/** Plain, serialisable job state. No buffers, no process handles. */
export interface JobRecord {
  id: string;
  command: string;
  cwd: string;
  onDone: string;
  label?: string;
  pid: number;
  startedAt: number;
  endedAt?: number;
  status: JobStatus;
  exitCode?: number | null;
  signal?: string | null;
  timedOut?: boolean;
  /** True once the completion has been delivered back to the model. */
  announced: boolean;
}

export interface ExitInfo {
  exitCode: number | null;
  signal: string | null;
  error?: string;
  timedOut: boolean;
}

/** Shape of a bounded output snapshot; mirrors pi's bash output schema. */
export interface OutputSnapshot {
  output: string;
  truncated: boolean;
  truncatedBy: "lines" | "bytes" | null;
  totalLines: number;
  totalBytes: number;
  fullOutputPath?: string;
}

/**
 * A settled-capable job as seen by the registry and the wake scheduler.
 * The concrete implementation lives in `service.ts`; this interface keeps
 * `registry.ts` and `waker.ts` free of process and buffer details.
 */
export interface JobEntry {
  readonly record: JobRecord;
  snapshot(): OutputSnapshot;
  /** Terminate the underlying process tree. Idempotent. */
  cancel(): Promise<void>;
}

export type SettleOutcome = {
  status: TerminalStatus;
  exitCode?: number | null;
  signal?: string | null;
  timedOut?: boolean;
};

export interface CancelResult {
  ok: boolean;
  record?: JobRecord;
  reason?: string;
}

export interface StartResult {
  ok: boolean;
  entry?: JobEntry;
  reason?: string;
}
