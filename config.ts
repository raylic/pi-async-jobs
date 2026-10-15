/**
 * Defaults for the async-jobs extension.
 *
 * Output limits mirror pi's built-in bash tool (2000 lines / 50KB, tail-biased,
 * full output spilled to a temp file) so a job's output looks the same as a
 * foreground command's.
 */

import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "./buffer.ts";

export interface JobConfig {
  /** Maximum number of simultaneously running jobs. */
  maxConcurrent: number;
  /** Tail-truncation limits for a job's output (mirrors built-in bash). */
  maxLines: number;
  maxBytes: number;
  /** How long completions are batched before an idle wake-up fires. */
  wakeDebounceMs: number;
  /** SIGTERM -> SIGKILL grace period when cancelling. */
  sigtermGraceMs: number;
  /** Cap on the untrusted output preview embedded in a completion message. */
  previewBytes: number;
  /** Cap on the `on_done` intent string. */
  onDoneMaxBytes: number;
  /** Default per-job timeout; undefined means no timeout. */
  defaultTimeoutMs?: number;
}

export const DEFAULT_CONFIG: JobConfig = {
  maxConcurrent: 8,
  maxLines: DEFAULT_MAX_LINES,
  maxBytes: DEFAULT_MAX_BYTES,
  wakeDebounceMs: 1000,
  sigtermGraceMs: 5000,
  previewBytes: 4096,
  onDoneMaxBytes: 2048,
};

export function resolveConfig(overrides: Partial<JobConfig> | undefined): JobConfig {
  const merged = { ...DEFAULT_CONFIG, ...(overrides ?? {}) };
  return {
    ...merged,
    maxConcurrent: Math.max(1, Math.floor(merged.maxConcurrent)),
    maxLines: Math.max(1, Math.floor(merged.maxLines)),
    maxBytes: Math.max(256, Math.floor(merged.maxBytes)),
    wakeDebounceMs: Math.max(0, Math.floor(merged.wakeDebounceMs)),
    sigtermGraceMs: Math.max(0, Math.floor(merged.sigtermGraceMs)),
    previewBytes: Math.max(256, Math.floor(merged.previewBytes)),
    onDoneMaxBytes: Math.max(64, Math.floor(merged.onDoneMaxBytes)),
  };
}
