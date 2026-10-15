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
  /**
   * A bash command still running after this long is moved to the background.
   * 0 disables the takeover (bash then blocks like before).
   */
  detachAfterMs: number;
  /**
   * Narrow whitelist of command families that are certainly long-running.
   * Regex sources, matched at the start of each `&&`/`;`/`|` segment.
   */
  slowCommandPatterns: string[];
  /** Whether to intercept an obviously-long bash command before it runs. */
  interceptSlowCommands: boolean;
  /** How long a warned command is remembered before it may be intercepted again. */
  interceptMemoMs: number;
}

/**
 * Deliberately narrow: only command families whose duration is a near-certainty.
 * Anything else is left to the timeout takeover, which cannot misfire.
 */
export const DEFAULT_SLOW_COMMAND_PATTERNS: string[] = [
  "^(sudo\\s+)?(docker|podman)\\s+(build|buildx|compose\\s+(up|build|down|logs\\s+-f))",
  "^(sudo\\s+)?terraform\\s+(apply|plan|init|destroy|import)",
  "^(sudo\\s+)?(npm|pnpm|yarn|bun)\\s+(run\\s+\\S+|install|i|ci|add|build|test)",
  "^(sudo\\s+)?(python3?\\s+-m\\s+pytest|pytest)(\\s|$)",
  "^(sudo\\s+)?(cargo|go|gradle|mvn|bazel|\\./gradlew|\\./mvnw)\\s+(build|test|run|install|package|verify)",
  "^(sudo\\s+)?make(\\s|$)",
  "^(sudo\\s+)?(webpack|rollup|esbuild|vite|next|nuxt|astro)\\s+(build|dev)",
  "^(sudo\\s+)?(nodemon|watch|tail\\s+-f|ffmpeg|sleep)(\\s|$)",
];

export const DEFAULT_CONFIG: JobConfig = {
  maxConcurrent: 8,
  maxLines: DEFAULT_MAX_LINES,
  maxBytes: DEFAULT_MAX_BYTES,
  wakeDebounceMs: 1000,
  sigtermGraceMs: 5000,
  previewBytes: 4096,
  onDoneMaxBytes: 2048,
  detachAfterMs: 15000,
  slowCommandPatterns: DEFAULT_SLOW_COMMAND_PATTERNS,
  interceptSlowCommands: true,
  interceptMemoMs: 300000,
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
    detachAfterMs: Math.max(0, Math.floor(merged.detachAfterMs)),
    interceptMemoMs: Math.max(0, Math.floor(merged.interceptMemoMs)),
  };
}
