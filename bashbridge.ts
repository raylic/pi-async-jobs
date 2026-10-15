/**
 * Timeout takeover for `bash`.
 *
 * A command that is still running after `detachAfterMs` is handed to the job
 * registry and the bash call returns immediately. Unlike soft interception this
 * cannot misfire, so it is the safety net that covers every command nobody could
 * have known was slow — including the ones the whitelist misses.
 *
 * Two contracts matter here:
 *
 *  1. **The bash result shape is preserved.** pi's built-in bash declares an
 *     `outputSchema`, so codemode scripts calling `bash` receive
 *     `structuredContent`. A takeover still returns that shape, with the job id
 *     in `output`, so callers never see an unexpected object.
 *  2. **The turn signal is released before adopting.** `operations.exec` receives
 *     the AbortSignal of the *current turn*; leaving the listener attached would
 *     kill the background job the moment the turn ends or the user aborts.
 */

import { constants as osConstants } from "node:os";

import { OutputBuffer } from "./buffer.ts";
import type { ProcessRunner, RunningProcess } from "./runner.ts";

/** Marker prefix; the sentinel travels out as a thrown Error message. */
export const DETACH_PREFIX = "pi-async-jobs:backgrounded:";

/** Stand-in for the missing `on_done` when a command is taken over mid-flight. */
export const AUTO_BACKGROUND_ON_DONE =
	"(自动转后台：调用方没有声明后续。拿到结果后请依据上下文判断该做什么)";

export function detachSentinel(jobId: string): Error {
	return new Error(`${DETACH_PREFIX}${jobId}`);
}

export function extractDetachedJobId(message: string): string | undefined {
	const index = message.indexOf(DETACH_PREFIX);
	if (index === -1) return undefined;
	const rest = message.slice(index + DETACH_PREFIX.length).trim();
	const id = rest.split(/\s/)[0];
	return id.length > 0 ? id : undefined;
}

export interface AdoptRequest {
	command: string;
	cwd: string;
	handle: RunningProcess;
	buffer: OutputBuffer;
	startedAt: number;
}

export interface BashBridgeDeps {
	runner: ProcessRunner;
	/** 0 disables the takeover: bash then blocks until the command ends. */
	detachAfterMs: number;
	maxLines: number;
	maxBytes: number;
	/** Register the already-running process as a job; returns its id. */
	adopt(request: AdoptRequest): string;
	now?: () => number;
}

export interface BridgeExecOptions {
	onData: (chunk: Buffer) => void;
	signal?: AbortSignal;
	/** Seconds, matching the bash tool's `timeout` parameter. */
	timeout?: number;
	env?: NodeJS.ProcessEnv;
}

export interface BashBridge {
	exec(command: string, cwd: string, options: BridgeExecOptions): Promise<{ exitCode: number | null }>;
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createBashBridge(deps: BashBridgeDeps): BashBridge {
	const now = deps.now ?? Date.now;

	return {
		async exec(command, cwd, options) {
			if (options.signal?.aborted) throw new Error("aborted");

			const startedAt = now();
			const buffer = new OutputBuffer({ maxLines: deps.maxLines, maxBytes: deps.maxBytes });
			let forwardToCaller = true;

			const handle = deps.runner.start(
				{
					command,
					cwd,
					env: options.env,
					timeoutMs: options.timeout !== undefined ? options.timeout * 1000 : undefined,
				},
				{
					onData: (chunk) => {
						buffer.append(chunk);
						if (forwardToCaller) options.onData(chunk);
					},
				},
			);

			// Abort may kill the command while we are still waiting on it. Once it
			// becomes a job, the abort must no longer reach it.
			let inForeground = true;
			const onAbort = () => {
				if (inForeground) void handle.kill();
			};
			if (options.signal) {
				if (options.signal.aborted) onAbort();
				else options.signal.addEventListener("abort", onAbort, { once: true });
			}
			const releaseAbort = () => {
				inForeground = false;
				options.signal?.removeEventListener("abort", onAbort);
			};

			try {
				if (deps.detachAfterMs > 0) {
					const outcome = await Promise.race([
						handle.exited.then(() => "exited" as const),
						delay(deps.detachAfterMs).then(() => "detach" as const),
					]);
					if (outcome === "detach") {
						releaseAbort();
						forwardToCaller = false;
						const jobId = deps.adopt({ command, cwd, handle, buffer, startedAt });
						throw detachSentinel(jobId);
					}
				}

				const info = await handle.exited;
				releaseAbort();
				// The buffer only existed in case we had to adopt; drop its spill file.
				await buffer.dispose();
				if (options.signal?.aborted) throw new Error("aborted");
				if (info.error) throw new Error(info.error);
				if (info.timedOut) throw new Error(`timeout:${options.timeout}`);
				const exitCode =
					info.exitCode ?? (info.signal ? 128 + (osConstants.signals[info.signal] ?? 0) : 1);
				return { exitCode };
			} finally {
				options.signal?.removeEventListener("abort", onAbort);
			}
		},
	};
}

export interface BackgroundedResult {
	content: { type: "text"; text: string }[];
	details: Record<string, unknown>;
	/** Same shape as the built-in bash tool's structuredContent. */
	structuredContent: {
		output: string;
		truncated: boolean;
		full_output_path?: string;
		exit_code: number;
		wall_time_seconds: number;
	};
}

/** Bash-shaped result for a command that was moved to the background. */
export function formatBackgroundedResult(input: {
	jobId: string;
	command: string;
	detachAfterMs: number;
	elapsedMs: number;
}): BackgroundedResult {
	const seconds = Math.round(input.detachAfterMs / 1000);
	const text = [
		`命令在 ${seconds} 秒内没有结束，已自动转为后台任务 ${input.jobId}（整个进程树由本插件管理）。`,
		`命令: ${input.command}`,
		"你这一轮不会被阻塞了。任务结束时，结果会作为新消息送达。",
		"注意：这条命令不是你用 job_start 发起的，所以没有 on_done —— 结果回来时请依据上下文判断该做什么。",
		`现在也可以: job_read({"id":"${input.jobId}"}) 查看已有输出，job_cancel({"id":"${input.jobId}"}) 取消。`,
	].join("\n");

	return {
		content: [{ type: "text", text }],
		details: { backgrounded: true, jobId: input.jobId },
		structuredContent: {
			output: text,
			truncated: false,
			exit_code: 0,
			wall_time_seconds: Math.round(input.elapsedMs / 100) / 10,
		},
	};
}
