import test from "node:test";
import assert from "node:assert/strict";

import {
	AUTO_BACKGROUND_ON_DONE,
	createBashBridge,
	detachSentinel,
	extractDetachedJobId,
	formatBackgroundedResult,
	type AdoptRequest,
} from "../bashbridge.ts";
import { OutputBuffer } from "../buffer.ts";
import { ProcessRunner } from "../runner.ts";
import type { ExitInfo } from "../types.ts";

class FakeHandle {
	pid = 777;
	pgid = 777;
	timedOut = false;
	killed = false;
	private resolveExit!: (info: ExitInfo) => void;
	readonly exited: Promise<ExitInfo>;
	constructor() {
		this.exited = new Promise<ExitInfo>((resolve) => {
			this.resolveExit = resolve;
		});
	}
	finish(exitCode: number | null, signal: string | null = null, extra: Partial<ExitInfo> = {}): void {
		this.resolveExit({ exitCode, signal, timedOut: this.timedOut, ...extra });
	}
	kill(): Promise<void> {
		this.killed = true;
		this.finish(null, "SIGTERM");
		return Promise.resolve();
	}
}

class FakeRunner {
	spec: Record<string, unknown> | undefined;
	handle: FakeHandle | undefined;
	private onData: ((chunk: Buffer, stream: "stdout" | "stderr") => void) | undefined;

	start(spec: Record<string, unknown>, handlers: { onData?: (chunk: Buffer, stream: "stdout" | "stderr") => void }): FakeHandle {
		this.spec = spec;
		this.onData = handlers.onData;
		this.handle = new FakeHandle();
		return this.handle;
	}

	emit(text: string): void {
		this.onData?.(Buffer.from(text), "stdout");
	}
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function setup(detachAfterMs = 40) {
	const runner = new FakeRunner();
	const adopted: AdoptRequest[] = [];
	const bridge = createBashBridge({
		runner: runner as never,
		detachAfterMs,
		maxLines: 2000,
		maxBytes: 50 * 1024,
		adopt: (request) => {
			adopted.push(request);
			return "j9";
		},
	});
	return { runner, adopted, bridge };
}

test("a command that finishes inside the window behaves exactly like bash", async () => {
	const { runner, adopted, bridge } = setup();
	const chunks: string[] = [];
	const promise = bridge.exec("printf hi", "/work", { onData: (chunk) => chunks.push(chunk.toString()) });

	runner.emit("hi");
	runner.handle!.finish(0);

	assert.deepEqual(await promise, { exitCode: 0 });
	assert.deepEqual(chunks, ["hi"]);
	assert.equal(adopted.length, 0, "nothing is adopted when the command finishes");
});

test("a non-zero exit code is passed through", async () => {
	const { runner, bridge } = setup();
	const promise = bridge.exec("false", "/work", { onData: () => {} });
	runner.handle!.finish(3);
	assert.deepEqual(await promise, { exitCode: 3 });
});

test("a signal-killed command reports the shell convention exit code", async () => {
	const { runner, bridge } = setup();
	const promise = bridge.exec("sleep 1", "/work", { onData: () => {} });
	runner.handle!.finish(null, "SIGTERM");
	assert.deepEqual(await promise, { exitCode: 143 });
});

test("a command still running after the window is adopted and the call returns at once", async () => {
	const { runner, adopted, bridge } = setup(30);
	const chunks: string[] = [];
	const promise = bridge.exec("npm run build", "/work", { onData: (chunk) => chunks.push(chunk.toString()) });
	// Attach the rejection handler immediately; the rejection happens while we wait.
	const rejection = promise.then(
		() => undefined,
		(error: Error) => error,
	);

	runner.emit("building…");
	await sleep(60);

	const error = await rejection;
	assert.ok(error, "the call must reject with the detach sentinel");
	assert.equal(extractDetachedJobId(error!.message), "j9");
	assert.equal(adopted.length, 1);
	assert.equal(adopted[0].command, "npm run build");
	assert.equal(adopted[0].cwd, "/work");
	assert.ok(adopted[0].buffer instanceof OutputBuffer);
	assert.deepEqual(chunks, ["building…"]);

	// Output keeps flowing into the job buffer, but no longer to the bash call.
	runner.emit("more");
	assert.deepEqual(chunks, ["building…"], "the bash call must stop receiving output");
	const snapshot = adopted[0].buffer.snapshot();
	assert.match(snapshot.output, /building…more/);
	await adopted[0].buffer.dispose();
});

test("detachAfterMs 0 disables the takeover", async () => {
	const { runner, adopted, bridge } = setup(0);
	const promise = bridge.exec("sleep 99", "/work", { onData: () => {} });
	await tick();
	assert.equal(adopted.length, 0);
	runner.handle!.finish(0);
	assert.deepEqual(await promise, { exitCode: 0 });
});

test("aborting during the window kills the command and reports the cancellation", async () => {
	const { runner, bridge } = setup();
	const controller = new AbortController();
	const promise = bridge.exec("sleep 99", "/work", { onData: () => {}, signal: controller.signal });
	await tick();
	controller.abort();

	await assert.rejects(promise, /aborted/);
	assert.equal(runner.handle!.killed, true);
});

test("an already-aborted signal prevents the command from starting", async () => {
	const { runner, bridge } = setup();
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(bridge.exec("sleep 99", "/work", { onData: () => {}, signal: controller.signal }), /aborted/);
	assert.equal(runner.spec, undefined, "no process should have been spawned");
});

test("a job adopted past the window is no longer killed by a later abort", async () => {
	const { runner, adopted, bridge } = setup(30);
	const controller = new AbortController();
	const promise = bridge.exec("npm run build", "/work", { onData: () => {}, signal: controller.signal });
	const rejection = promise.then(
		() => undefined,
		(error: Error) => error,
	);
	await sleep(60);
	assert.ok(await rejection, "the call must reject with the detach sentinel");

	controller.abort();
	await tick();
	assert.equal(adopted.length, 1);
	assert.equal(runner.handle!.killed, false, "the abort must not reach the adopted job");
});

test("the timeout parameter is forwarded and surfaced as the built-in message", async () => {
	const { runner, bridge } = setup();
	const promise = bridge.exec("sleep 99", "/work", { onData: () => {}, timeout: 5 });
	assert.equal(runner.spec!.timeoutMs, 5000);
	runner.handle!.timedOut = true;
	runner.handle!.finish(null, "SIGTERM");
	await assert.rejects(promise, /^Error: timeout:5$/);
});

test("spawn failures are rethrown", async () => {
	const { runner, bridge } = setup();
	const promise = bridge.exec("nope", "/work", { onData: () => {} });
	runner.handle!.finish(null, null, { error: "spawn ENOENT" });
	await assert.rejects(promise, /spawn ENOENT/);
});

test("the detach sentinel round-trips", () => {
	assert.equal(extractDetachedJobId(detachSentinel("j3").message), "j3");
	assert.equal(extractDetachedJobId("some other error"), undefined);
	assert.equal(extractDetachedJobId(`wrapped: ${detachSentinel("j12").message}`), "j12");
});

test("the backgrounded result keeps the bash shape for codemode callers", () => {
	const result = formatBackgroundedResult({ jobId: "j7", command: "npm run build", detachAfterMs: 15000, elapsedMs: 15012 });

	assert.equal(result.structuredContent.exit_code, 0);
	assert.equal(result.structuredContent.truncated, false);
	assert.equal(result.structuredContent.full_output_path, undefined);
	assert.equal(result.structuredContent.wall_time_seconds, 15);
	assert.match(result.structuredContent.output, /j7/);
	assert.equal(result.structuredContent.output, result.content[0].text, "scripts and the model see the same text");

	assert.match(result.content[0].text, /15 秒/);
	assert.match(result.content[0].text, /没有 on_done/);
	assert.match(result.content[0].text, /job_read/);
	assert.equal(result.details.jobId, "j7");
});

test("the auto-background placeholder explains the missing intent", () => {
	assert.match(AUTO_BACKGROUND_ON_DONE, /没有声明后续/);
});

test("the takeover works against a real process", async () => {
	const runner = new ProcessRunner({ graceMs: 200 });
	const adopted: AdoptRequest[] = [];
	const bridge = createBashBridge({
		runner,
		detachAfterMs: 300,
		maxLines: 2000,
		maxBytes: 50 * 1024,
		adopt: (request) => {
			adopted.push(request);
			return "jreal";
		},
	});

	const chunks: string[] = [];
	const promise = bridge.exec("printf started; sleep 30", process.cwd(), {
		onData: (chunk) => chunks.push(chunk.toString()),
	});
	const error = await promise.then(
		() => undefined,
		(caught: Error) => caught,
	);

	try {
		assert.ok(error, "a long real command must be taken over");
		assert.equal(extractDetachedJobId(error!.message), "jreal");
		assert.equal(chunks.join(""), "started", "output before the takeover reached the bash call");
		assert.equal(adopted.length, 1);
		assert.ok(adopted[0].handle.pid > 0);

		await adopted[0].handle.kill();
		const info = await adopted[0].handle.exited;
		assert.ok(info.exitCode !== 0 || info.signal !== null, "the adopted process was still alive and got killed");
	} finally {
		await adopted[0]?.buffer.dispose();
	}
});
