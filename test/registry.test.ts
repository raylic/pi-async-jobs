import test from "node:test";
import assert from "node:assert/strict";

import { JobRegistry } from "../registry.ts";
import type { JobEntry, JobRecord } from "../types.ts";

function makeEntry(id: string): JobEntry {
	const record: JobRecord = {
		id,
		command: `echo ${id}`,
		cwd: "/tmp",
		onDone: "do the next thing",
		pid: 1,
		startedAt: 1000,
		status: "running",
		announced: false,
	};
	return {
		record,
		snapshot: () => ({ output: "", truncated: false, truncatedBy: null, totalLines: 0, totalBytes: 0 }),
		cancel: async () => {},
	};
}

test("settle moves running to terminal exactly once", () => {
	const registry = new JobRegistry(() => 5000);
	registry.add(makeEntry("j1"));

	assert.equal(registry.settle("j1", { status: "exited", exitCode: 0 }), true);
	const record = registry.get("j1")!.record;
	assert.equal(record.status, "exited");
	assert.equal(record.exitCode, 0);
	assert.equal(record.endedAt, 5000);

	// A late process exit must not overwrite the first outcome.
	assert.equal(registry.settle("j1", { status: "failed", exitCode: 1 }), false);
	assert.equal(registry.get("j1")!.record.status, "exited");
});

test("settle on an unknown job is a no-op", () => {
	const registry = new JobRegistry();
	assert.equal(registry.settle("nope", { status: "exited" }), false);
});

test("announce is a one-shot atomic claim", () => {
	const registry = new JobRegistry();
	registry.add(makeEntry("j1"));

	// Running jobs cannot be announced.
	assert.equal(registry.announce("j1"), false);

	registry.settle("j1", { status: "exited", exitCode: 0 });
	assert.equal(registry.announce("j1"), true);
	assert.equal(registry.announce("j1"), false);
	assert.equal(registry.announce("unknown"), false);
});

test("pending lists settled, unannounced jobs only", () => {
	const registry = new JobRegistry();
	registry.add(makeEntry("j1"));
	registry.add(makeEntry("j2"));
	registry.add(makeEntry("j3"));

	registry.settle("j2", { status: "failed", exitCode: 1 });
	registry.settle("j3", { status: "exited", exitCode: 0 });
	registry.announce("j3");

	assert.deepEqual(
		registry.pending().map((entry) => entry.record.id),
		["j2"],
	);
	assert.equal(registry.runningCount(), 1);
});

test("clear empties the registry", () => {
	const registry = new JobRegistry();
	registry.add(makeEntry("j1"));
	registry.clear();
	assert.equal(registry.size(), 0);
	assert.equal(registry.get("j1"), undefined);
});
