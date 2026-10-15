import test from "node:test";
import assert from "node:assert/strict";

import { formatStatusText, StatusPublisher, truncateCommand } from "../status.ts";
import type { JobRecord } from "../types.ts";

function record(id: string, status: JobRecord["status"], command = `run ${id}`): JobRecord {
	return {
		id,
		command,
		cwd: "/work",
		onDone: "next",
		pid: 1,
		startedAt: 0,
		status,
		announced: false,
	};
}

test("truncateCommand collapses whitespace and clips long commands", () => {
	assert.equal(truncateCommand("  npm   run\n  build "), "npm run build");
	const long = truncateCommand("x".repeat(200));
	assert.equal(long.length, 48);
	assert.ok(long.endsWith("…"));
});

test("no running jobs means no status text", () => {
	assert.equal(formatStatusText([]), undefined);
	assert.equal(formatStatusText([record("j1", "exited"), record("j2", "failed")]), undefined);
});

test("a single running job shows its id and command", () => {
	const text = formatStatusText([record("j1", "running", "npm run build"), record("j2", "exited")]);
	assert.ok(text);
	assert.match(text!, /j1/);
	assert.match(text!, /npm run build/);
	assert.ok(!text!.includes("j2"), "finished jobs must not appear");
});

test("several running jobs are summarised by count and ids", () => {
	const text = formatStatusText([record("j1", "running"), record("j2", "exited"), record("j3", "running")]);
	assert.ok(text);
	assert.match(text!, /2 个任务运行中/);
	assert.match(text!, /j1 j3/);
});

test("the publisher skips unchanged values and clears when idle", () => {
	const calls: (string | undefined)[] = [];
	let jobs: JobRecord[] = [];
	const publisher = new StatusPublisher({
		records: () => jobs,
		sink: (text) => calls.push(text),
	});

	jobs = [record("j1", "running")];
	publisher.refresh();
	publisher.refresh();
	assert.deepEqual(calls, ["⚙ j1 运行中: run j1"]);

	jobs = [record("j1", "running"), record("j2", "running")];
	publisher.refresh();
	assert.equal(calls.length, 2);
	assert.match(calls[1]!, /2 个任务运行中/);

	jobs = [record("j1", "exited"), record("j2", "exited")];
	publisher.refresh();
	assert.equal(calls.length, 3);
	assert.equal(calls[2], undefined, "the footer must be cleared once nothing runs");

	// Already cleared: no further calls.
	publisher.refresh();
	assert.equal(calls.length, 3);
});

test("clear publishes undefined and is a no-op afterwards", () => {
	const calls: (string | undefined)[] = [];
	const publisher = new StatusPublisher({ records: () => [record("j1", "running")], sink: (text) => calls.push(text) });
	publisher.refresh();
	publisher.clear();
	publisher.clear();
	assert.deepEqual(calls, ["⚙ j1 运行中: run j1", undefined]);
});
