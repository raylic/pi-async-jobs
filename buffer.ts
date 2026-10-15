/**
 * Bounded, tail-biased output buffer for background jobs.
 *
 * Mirrors the behaviour of pi's internal `OutputAccumulator` and `truncateTail`
 * (dist/core/tools/output-accumulator.js, dist/core/tools/truncate.js). Those
 * are not part of the public API, so the algorithm is reproduced here to keep
 * this module dependency-free and unit-testable outside the pi runtime.
 *
 * Behaviour:
 *  - output is decoded with a streaming UTF-8 decoder (multibyte-safe)
 *  - only a rolling tail is kept in memory (bounded, independent of job size)
 *  - once the limits are exceeded, the raw stream is spilled to a temp file
 *  - `snapshot()` returns the last `maxLines` lines / `maxBytes` bytes plus the
 *    spill path, exactly like the built-in bash tool's result
 */

import { randomBytes } from "node:crypto";
import { createWriteStream, type WriteStream } from "node:fs";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OutputSnapshot } from "./types.ts";

export const DEFAULT_MAX_LINES = 2000;
export const DEFAULT_MAX_BYTES = 50 * 1024;

export interface TruncationResult {
  content: string;
  truncated: boolean;
  truncatedBy: "lines" | "bytes" | null;
  totalLines: number;
  totalBytes: number;
  maxLines: number;
  maxBytes: number;
}

export interface TruncationOptions {
  maxLines?: number;
  maxBytes?: number;
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function splitLinesForCounting(content: string): string[] {
  if (content.length === 0) return [];
  const lines = content.split("\n");
  if (content.endsWith("\n")) lines.pop();
  return lines;
}

function truncateStringToBytesFromEnd(str: string, maxBytes: number): string {
  const buf = Buffer.from(str, "utf-8");
  if (buf.length <= maxBytes) return str;
  let start = buf.length - maxBytes;
  while (start < buf.length && (buf[start] & 0xc0) === 0x80) start++;
  return buf.subarray(start).toString("utf-8");
}

/** Keep the last `maxLines` lines / `maxBytes` bytes. Mirrors pi's `truncateTail`. */
export function truncateTail(content: string, options: TruncationOptions = {}): TruncationResult {
  const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const totalBytes = Buffer.byteLength(content, "utf-8");
  const lines = splitLinesForCounting(content);
  const totalLines = lines.length;

  if (totalLines <= maxLines && totalBytes <= maxBytes) {
    return { content, truncated: false, truncatedBy: null, totalLines, totalBytes, maxLines, maxBytes };
  }

  const outputLines: string[] = [];
  let outputBytes = 0;
  let truncatedBy: "lines" | "bytes" = "lines";

  for (let i = lines.length - 1; i >= 0 && outputLines.length < maxLines; i--) {
    const line = lines[i];
    const lineBytes = Buffer.byteLength(line, "utf-8") + (outputLines.length > 0 ? 1 : 0);
    if (outputBytes + lineBytes > maxBytes) {
      truncatedBy = "bytes";
      if (outputLines.length === 0) {
        const partial = truncateStringToBytesFromEnd(line, maxBytes);
        outputLines.unshift(partial);
        outputBytes = Buffer.byteLength(partial, "utf-8");
      }
      break;
    }
    outputLines.unshift(line);
    outputBytes += lineBytes;
  }

  if (outputLines.length >= maxLines && outputBytes <= maxBytes) truncatedBy = "lines";

  return {
    content: outputLines.join("\n"),
    truncated: true,
    truncatedBy,
    totalLines,
    totalBytes,
    maxLines,
    maxBytes,
  };
}

export interface OutputBufferOptions {
  maxLines?: number;
  maxBytes?: number;
  tempFilePrefix?: string;
}

function defaultTempFilePath(prefix: string): string {
  return join(tmpdir(), `${prefix}-${randomBytes(8).toString("hex")}.log`);
}

/**
 * Streaming, bounded accumulator for one job's stdout+stderr.
 * Not thread-safe; feed it from a single process's data events.
 */
export class OutputBuffer {
  private readonly maxLines: number;
  private readonly maxBytes: number;
  private readonly maxRollingBytes: number;
  private readonly tempFilePrefix: string;

  private readonly decoder = new TextDecoder();
  private rawChunks: Buffer[] = [];
  private tailText = "";
  private tailBytes = 0;
  private tailStartsAtLineBoundary = true;
  private totalRawBytes = 0;
  private totalDecodedBytes = 0;
  private completedLines = 0;
  private totalLines = 0;
  private hasOpenLine = false;
  private finished = false;
  private disposed = false;

  private tempFilePath: string | undefined;
  private tempFileStream: WriteStream | undefined;

  constructor(options: OutputBufferOptions = {}) {
    this.maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    // Keep 2x the display limit around so `truncateTail` always has enough
    // context to produce the exact same result it would on the full stream.
    this.maxRollingBytes = Math.max(this.maxBytes * 2, 1);
    this.tempFilePrefix = options.tempFilePrefix ?? "pi-job";
  }

  append(data: Buffer): void {
    if (this.finished) throw new Error("Cannot append to a finished OutputBuffer");
    this.totalRawBytes += data.length;
    this.appendDecodedText(this.decoder.decode(data, { stream: true }));

    if (this.tempFileStream || this.shouldSpill()) {
      this.ensureTempFile();
      this.tempFileStream?.write(data);
    } else if (data.length > 0) {
      this.rawChunks.push(data);
    }
  }

  /** Flush the decoder. Call once the process has closed its streams. */
  finish(): void {
    if (this.finished) return;
    this.finished = true;
    this.appendDecodedText(this.decoder.decode());
    if (this.shouldSpill()) this.ensureTempFile();
  }

  get totalBytes(): number {
    return this.totalDecodedBytes;
  }

  get truncated(): boolean {
    return this.totalLines > this.maxLines || this.totalDecodedBytes > this.maxBytes;
  }

  get path(): string | undefined {
    return this.tempFilePath;
  }

  /**
   * Bounded view of the output so far. Safe to call while the job is running.
   * Creates the spill file when truncation has occurred.
   */
  snapshot(): OutputSnapshot {
    const tail = truncateTail(this.getSnapshotText(), { maxLines: this.maxLines, maxBytes: this.maxBytes });
    const truncated = this.truncated;
    const truncatedBy = truncated
      ? (tail.truncatedBy ?? (this.totalDecodedBytes > this.maxBytes ? "bytes" : "lines"))
      : null;
    if (truncated && !this.disposed) this.ensureTempFile();
    return {
      output: tail.content,
      truncated,
      truncatedBy,
      totalLines: this.totalLines,
      totalBytes: this.totalDecodedBytes,
      fullOutputPath: this.tempFilePath,
    };
  }

  /** Finish decoding and flush the spill file to disk. */
  async close(): Promise<void> {
    this.finish();
    if (!this.tempFileStream) return;
    const stream = this.tempFileStream;
    this.tempFileStream = undefined;
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        stream.off("finish", onFinish);
        reject(error);
      };
      const onFinish = () => {
        stream.off("error", onError);
        resolve();
      };
      stream.once("error", onError);
      stream.once("finish", onFinish);
      stream.end();
    });
  }

  /** Close and delete the spill file. Used when pi shuts down and kills jobs. */
  async dispose(): Promise<void> {
    await this.close().catch(() => {});
    this.disposed = true;
    const path = this.tempFilePath;
    this.tempFilePath = undefined;
    this.rawChunks = [];
    if (path) await unlink(path).catch(() => {});
  }

  private appendDecodedText(text: string): void {
    if (text.length === 0) return;
    const bytes = Buffer.byteLength(text, "utf-8");
    this.totalDecodedBytes += bytes;
    this.tailText += text;
    this.tailBytes += bytes;
    if (this.tailBytes > this.maxRollingBytes * 2) this.trimTail();

    let newlines = 0;
    let lastNewline = -1;
    for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) {
      newlines++;
      lastNewline = i;
    }
    if (newlines === 0) {
      this.hasOpenLine = true;
    } else {
      this.completedLines += newlines;
      const tail = text.slice(lastNewline + 1);
      this.hasOpenLine = tail.length > 0;
    }
    this.totalLines = this.completedLines + (this.hasOpenLine ? 1 : 0);
  }

  private trimTail(): void {
    const buffer = Buffer.from(this.tailText, "utf-8");
    if (buffer.length <= this.maxRollingBytes) {
      this.tailBytes = buffer.length;
      return;
    }
    let start = buffer.length - this.maxRollingBytes;
    while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start++;
    this.tailStartsAtLineBoundary = start === 0 ? this.tailStartsAtLineBoundary : buffer[start - 1] === 0x0a;
    this.tailText = buffer.subarray(start).toString("utf-8");
    this.tailBytes = Buffer.byteLength(this.tailText, "utf-8");
  }

  private getSnapshotText(): string {
    if (this.tailStartsAtLineBoundary) return this.tailText;
    const firstNewline = this.tailText.indexOf("\n");
    return firstNewline === -1 ? this.tailText : this.tailText.slice(firstNewline + 1);
  }

  private shouldSpill(): boolean {
    return this.totalRawBytes > this.maxBytes || this.totalDecodedBytes > this.maxBytes || this.totalLines > this.maxLines;
  }

  private ensureTempFile(): void {
    if (this.tempFilePath || this.disposed) return;
    this.tempFilePath = defaultTempFilePath(this.tempFilePrefix);
    this.tempFileStream = createWriteStream(this.tempFilePath);
    for (const chunk of this.rawChunks) this.tempFileStream.write(chunk);
    this.rawChunks = [];
  }
}
