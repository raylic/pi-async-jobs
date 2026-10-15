import test from "node:test";
import assert from "node:assert/strict";

import { JobRegistry } from "../registry.ts";
import type { JobEntry, JobRecord, OutputSnapshot } from "../types.ts";
import { formatCompletionMessage, formatDuration, WakeScheduler, type WakeClock } from "../waker.ts";

function makeEntry(id: string, record: Partial<JobRecord> = {}, snapshot: Partial<OutputSnapshot> = {}): JobEntry {
	const base: JobRecord = {
		id,
		command: `run ${id}`,
		cwd: "/work",
		onDone: `then ${id}`,
		pid: 1,
		startedAt: 0,
		status: "running",
		announced: false,
	};
	return {
		record: { ...base, ...record },
		snapshot: () => ({
			output: `output of ${id}`,
			truncated: false,
			truncatedBy: null,
			totalLines: 1,
			totalBytes: 12,
			...snapshot,
		}),
		cancel: async () => {},
	};
}

interface TestClock extends WakeClock {
	advance(ms: number): void;
	pending(): number;
}

function fakeClock(): TestClock {
	let now = 1_000_000;
	let nextId = 1;
	const timers = new Map<number, { fn: () => void; ms: number }>();
	return {
		now: () => now,
		setTimeout: (fn, ms) => {
			const id = nextId++;
			timers.set(id, { fn, ms });
			return id;
		},
		clearTimeout: (handle) => {
			timers.delete(handle as number);
		},
		pending: () => timers.size,
		advance(ms) {
			now += ms;
			for (const [id, timer] of [...timers]) {
				if (timer.ms <= ms) {
					timers.delete(id);
					timer.fn();
				}
			}
		},
	};
}

function setup(options: { idle?: boolean; debounceMs?: number; sendThrows?: boolean } = {}) {
	const registry = new JobRegistry(() => 1_000_000);
	const clock = fakeClock();
	const sent: string[] = [];
	const state = { idle: options.idle ?? true };
	const waker = new WakeScheduler({
		pending: () => registry.pending(),
		announce: (id) => registry.announce(id),
		send: (content) => {
			if (options.sendThrows) throw new Error("session gone");
			sent.push(content);
		},
		isIdle: () => state.idle,
		debounceMs: options.debounceMs ?? 1000,
		previewBytes: 4096,
		clock,
	});
	return { registry, clock, sent, state, waker };
}

test("formatDuration", () => {
	assert.equal(formatDuration(500), "500ms");
	assert.equal(formatDuration(1500), "1.5s");
	assert.equal(formatDuration(15000), "15s");
	assert.equal(formatDuration(90_000), "1m30s");
	assert.equal(formatDuration(3_600_000), "1h0m");
});

test("formatCompletionMessage is self-describing and marks output as untrusted", () => {
	const registry = new JobRegistry(() => 1_000_000);
	const entry = makeEntry("j1", {
		status: "exited",
		exitCode: 0,
		startedAt: 0,
		endedAt: 3000,
		onDone: "deploy to staging",
	});
	registry.add(entry);
	registry.settle("j1", { status: "exited", exitCode: 0 });

	const message = formatCompletionMessage([entry], 4096);
	assert.match(message, /job j1/);
	assert.match(message, /deploy to staging/);
	assert.match(message, /run j1/);
	assert.match(message, /output of j1/);
	assert.match(message, /不可信数据/);
});

test("a busy session defers to the settle hook", () => {
	const { registry, clock, sent, waker } = setup({ idle: false });
	registry.add(makeEntry("j1"));
	registry.settle("j1", { status: "exited", exitCode: 0 });

	waker.noteSettled();
	assert.equal(waker.armed, false);
	assert.equal(clock.pending(), 0);
	assert.equal(sent.length, 0);
});

test("an idle session wakes once with all completions batched", () => {
	const { registry, clock, sent, waker } = setup({ idle: true, debounceMs: 1000 });
	registry.add(makeEntry("j1"));
	registry.add(makeEntry("j2"));
	registry.settle("j1", { status: "exited", exitCode: 0 });
	registry.settle("j2", { status: "failed", exitCode: 1 });

	waker.noteSettled();
	waker.noteSettled(); // second completion inside the debounce window
	assert.equal(waker.armed, true);
	assert.equal(clock.pending(), 1);

	clock.advance(1000);
	assert.equal(sent.length, 1);
	assert.match(sent[0], /j1/);
	assert.match(sent[0], /j2/);
	assert.equal(waker.armed, false);
});

test("the settle hook claims completions and asks for one continuation", () => {
	const { registry, sent, waker } = setup({ idle: false });
	registry.add(makeEntry("j1"));
	registry.settle("j1", { status: "exited", exitCode: 0 });

	const emission = waker.onBoundary({ outcome: "completed" });
	assert.ok(emission);
	assert.equal(emission!.continue, true);
	assert.match(emission!.content, /j1/);

	// Nothing left to report, so pi must be allowed to settle.
	assert.equal(waker.onBoundary({ outcome: "completed" }), undefined);
	assert.equal(sent.length, 0);
});

test("an aborted run is never restarted and never auto-woken", () => {
	const { registry, clock, sent, waker } = setup({ idle: true });
	registry.add(makeEntry("j1"));
	registry.settle("j1", { status: "exited", exitCode: 0 });

	assert.equal(waker.onBoundary({ outcome: "aborted" }), undefined);
	assert.equal(waker.armed, false, "must not wake a fresh turn right after a user abort");

	clock.advance(5000);
	assert.equal(sent.length, 0);

	// The result is not lost: the next completed settle delivers it.
	const emission = waker.onBoundary({ outcome: "completed" });
	assert.ok(emission);
	assert.match(emission!.content, /j1/);
});

test("a completion is delivered exactly once across both paths", () => {
	const { registry, clock, sent, waker } = setup({ idle: false });
	registry.add(makeEntry("j1"));
	registry.settle("j1", { status: "exited", exitCode: 0 });

	waker.onBoundary({ outcome: "completed" });
	waker.noteSettled();
	clock.advance(5000);

	assert.equal(sent.length, 0, "the settle hook already delivered it");
});

test("nothing happens without pending completions", () => {
	const { registry, clock, sent, waker } = setup({ idle: true });
	registry.add(makeEntry("j1")); // still running

	waker.noteSettled();
	assert.equal(waker.armed, false);
	clock.advance(5000);
	assert.equal(sent.length, 0);
	assert.equal(waker.onBoundary({ outcome: "completed" }), undefined);
});

test("flushing after dispose is inert and send failures are contained", () => {
	const { registry, clock, waker } = setup({ idle: true, sendThrows: true });
	registry.add(makeEntry("j1"));
	registry.settle("j1", { status: "exited", exitCode: 0 });

	waker.noteSettled();
	assert.doesNotThrow(() => clock.advance(1000));

	waker.dispose();
	assert.equal(waker.armed, false);
	assert.equal(waker.onBoundary({ outcome: "completed" }), undefined);
});

test("completion previews are bounded", () => {
	const { registry } = setup();
	const entry = makeEntry("j1", { status: "exited", exitCode: 0 }, { output: "x".repeat(10_000) });
	registry.add(entry);
	registry.settle("j1", { status: "exited", exitCode: 0 });

	const message = formatCompletionMessage([entry], 128);
	assert.ok(Buffer.byteLength(message) < 2000, "preview should be small even for huge output");
});
