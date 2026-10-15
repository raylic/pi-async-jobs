import test from "node:test";
import assert from "node:assert/strict";

import { OutputBuffer } from "../buffer.ts";
import { resolveConfig } from "../config.ts";
import { JobRegistry } from "../registry.ts";
import { JobService } from "../service.ts";
import type { ExitInfo } from "../types.ts";

class FakeHandle {
	pid = 4242;
	pgid = 4242;
	killed = false;
	timedOut = false;
	private resolveExit!: (info: ExitInfo) => void;
	readonly exited: Promise<ExitInfo>;

	constructor() {
		this.exited = new Promise<ExitInfo>((resolve) => {
			this.resolveExit = resolve;
		});
	}

	finish(exitCode: number | null, signal: string | null = null): void {
		this.resolveExit({ exitCode, signal, timedOut: this.timedOut });
	}

	kill(): Promise<void> {
		this.killed = true;
		this.finish(null, "SIGTERM");
		return Promise.resolve();
	}
}

class FakeRunner {
	handles: FakeHandle[] = [];
	startCalls: Record<string, unknown>[] = [];
	killAllCalled = false;
	readonly graceMs = 5000;

	start(options: Record<string, unknown>, _handlers: unknown): FakeHandle {
		this.startCalls.push(options);
		const handle = new FakeHandle();
		this.handles.push(handle);
		return handle;
	}

	async killAll(): Promise<void> {
		this.killAllCalled = true;
		for (const handle of this.handles) handle.kill();
	}
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function setup(overrides: Record<string, unknown> = {}) {
	const registry = new JobRegistry(() => 1_000_000);
	const runner = new FakeRunner();
	const settled: string[] = [];
	const service = new JobService({
		registry,
		runner: runner as never,
		config: resolveConfig({ maxConcurrent: 2, ...overrides }),
		now: () => 1_000_000,
		onSettled: (id) => settled.push(id),
	});
	return { registry, runner, settled, service };
}

function start(service: JobService, command = "sleep 1", onDone = "then do x") {
	const result = service.start({ command, cwd: "/work", onDone });
	assert.ok(result.ok && result.entry, result.reason ?? "start failed");
	return result.entry!;
}

test("start registers a running job and reports its pid", () => {
	const { service, registry } = setup();
	const entry = start(service, "npm run build");
	assert.equal(entry.record.status, "running");
	assert.equal(entry.record.pid, 4242);
	assert.equal(registry.runningCount(), 1);
	assert.equal(service.list().length, 1);
});

test("the concurrency limit rejects extra jobs", () => {
	const { service } = setup({ maxConcurrent: 2 });
	start(service, "a");
	start(service, "b");
	const third = service.start({ command: "c", cwd: "/work", onDone: "x" });
	assert.equal(third.ok, false);
	assert.match(third.reason!, /并发上限/);
});

test("on_done is clamped to the configured limit", () => {
	const { service } = setup({ onDoneMaxBytes: 64 });
	const entry = start(service, "cmd", "y".repeat(500));
	assert.ok(entry.record.onDone.length < 500, "expected the intent to be truncated");
	assert.ok(Buffer.byteLength(entry.record.onDone) <= 64 + 3);
});

test("a zero exit settles as exited and notifies the wake scheduler", async () => {
	const { service, registry, runner, settled } = setup();
	start(service);
	runner.handles[0].finish(0);
	await flush();

	const record = registry.get("j1")!.record;
	assert.equal(record.status, "exited");
	assert.equal(record.exitCode, 0);
	assert.deepEqual(
		registry.pending().map((entry) => entry.record.id),
		["j1"],
	);
	assert.deepEqual(settled, ["j1"]);
});

test("a non-zero exit settles as failed", async () => {
	const { service, registry, runner } = setup();
	start(service);
	runner.handles[0].finish(1);
	await flush();
	assert.equal(registry.get("j1")!.record.status, "failed");
	assert.equal(registry.get("j1")!.record.exitCode, 1);
});

test("cancelling an unknown job fails cleanly", async () => {
	const { service } = setup();
	const result = await service.cancel("nope");
	assert.equal(result.ok, false);
	assert.match(result.reason!, /未知的任务 id/);
});

test("an agent-issued cancel is marked delivered immediately", async () => {
	const { service, registry, runner, settled } = setup();
	start(service);
	const result = await service.cancel("j1", "agent");

	assert.equal(result.ok, true);
	assert.equal(result.record!.status, "cancelled");
	assert.equal(runner.handles[0].killed, true);
	assert.equal(registry.pending().length, 0, "the model already got the answer from the tool result");
	assert.deepEqual(settled, [], "no wake-up for a cancel the model itself issued");
});

test("a user-issued cancel flows through the completion path", async () => {
	const { service, registry, settled } = setup();
	start(service);
	await service.cancel("j1", "user");
	assert.deepEqual(
		registry.pending().map((entry) => entry.record.id),
		["j1"],
	);
	assert.deepEqual(settled, ["j1"]);
});

test("cancelling a settled job is idempotent", async () => {
	const { service, registry, runner } = setup();
	start(service);
	runner.handles[0].finish(0);
	await flush();

	const result = await service.cancel("j1", "agent");
	assert.equal(result.ok, true);
	assert.equal(result.record!.status, "exited");
	assert.equal(runner.handles[0].killed, false);
});

test("a late process exit cannot overwrite a cancel", async () => {
	const { service, registry, runner } = setup();
	start(service);
	await service.cancel("j1", "agent");
	// The process finally closes after the cancel already settled it.
	runner.handles[0].finish(null, "SIGTERM");
	await flush();
	assert.equal(registry.get("j1")!.record.status, "cancelled");
});

test("view returns a bounded snapshot and unknown ids are reported", () => {
	const { service } = setup();
	start(service, "echo hi");
	const view = service.view("j1");
	assert.ok(view);
	assert.equal(view!.record.command, "echo hi");
	assert.equal(view!.snapshot.output, "");
	assert.equal(service.view("nope"), undefined);
});

test("shutdown kills every job and empties the registry", async () => {
	const { service, registry, runner } = setup();
	start(service, "a");
	start(service, "b");
	await service.shutdown();
	assert.equal(runner.killAllCalled, true);
	assert.equal(runner.handles.every((handle) => handle.killed), true);
	assert.equal(registry.size(), 0);
});

test("adopt registers an already-running process and settles it normally", async () => {
	const { service, registry, settled } = setup();
	const buffer = new OutputBuffer({});
	buffer.append(Buffer.from("taken over mid-flight"));
	const handle = new FakeHandle();

	const entry = service.adopt({
		spec: { command: "npm run build", cwd: "/work", onDone: "no intent" },
		buffer,
		handle: handle as never,
		startedAt: 900_000,
	});

	assert.equal(entry.record.status, "running");
	assert.equal(entry.record.pid, 4242);
	assert.equal(entry.record.startedAt, 900_000, "the original start time is preserved");
	assert.equal(registry.runningCount(), 1);
	assert.match(service.view(entry.record.id)!.snapshot.output, /taken over/);

	handle.finish(0);
	await flush();
	assert.equal(registry.get(entry.record.id)!.record.status, "exited");
	assert.deepEqual(settled, [entry.record.id]);
	await buffer.dispose();
});

test("adopt bypasses the concurrency gate", () => {
	const { service } = setup({ maxConcurrent: 1 });
	start(service, "a");
	assert.equal(service.start({ command: "b", cwd: "/work", onDone: "x" }).ok, false);

	const entry = service.adopt({
		spec: { command: "b", cwd: "/work", onDone: "x" },
		buffer: new OutputBuffer({}),
		handle: new FakeHandle() as never,
		startedAt: 1,
	});
	assert.equal(entry.record.id, "j2", "a running process is never refused");
});
