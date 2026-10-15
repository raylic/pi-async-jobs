/**
 * In-memory job registry: the single source of truth for job state.
 *
 * All state transitions funnel through `settle()` and `announce()`. Both are
 * idempotent, which is what makes the two wake-up paths safe: whichever path
 * calls `announce()` first wins, and the loser sees `false`.
 */

import type { JobEntry, SettleOutcome } from "./types.ts";

export class JobRegistry {
  private readonly entries = new Map<string, JobEntry>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  add(entry: JobEntry): void {
    this.entries.set(entry.record.id, entry);
  }

  get(id: string): JobEntry | undefined {
    return this.entries.get(id);
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }

  all(): JobEntry[] {
    return [...this.entries.values()];
  }

  size(): number {
    return this.entries.size;
  }

  running(): JobEntry[] {
    return this.all().filter((entry) => entry.record.status === "running");
  }

  runningCount(): number {
    return this.running().length;
  }

  /** Terminal jobs whose result has not been delivered to the model yet. */
  pending(): JobEntry[] {
    return this.all().filter((entry) => entry.record.status !== "running" && !entry.record.announced);
  }

  /**
   * Move a job to a terminal state. Returns false when it was already settled,
   * so a late process exit cannot overwrite a cancel.
   */
  settle(id: string, outcome: SettleOutcome): boolean {
    const entry = this.entries.get(id);
    if (!entry || entry.record.status !== "running") return false;
    const record = entry.record;
    record.status = outcome.status;
    record.exitCode = outcome.exitCode ?? null;
    record.signal = outcome.signal ?? null;
    record.timedOut = outcome.timedOut ?? false;
    record.endedAt = this.now();
    return true;
  }

  /** Atomically mark a settled job as delivered. Returns true only for the winner. */
  announce(id: string): boolean {
    const entry = this.entries.get(id);
    if (!entry) return false;
    if (entry.record.status === "running" || entry.record.announced) return false;
    entry.record.announced = true;
    return true;
  }

  clear(): void {
    this.entries.clear();
  }
}
