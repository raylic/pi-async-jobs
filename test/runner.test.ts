import test from "node:test";
import assert from "node:assert/strict";

import { ProcessRunner } from "../runner.ts";

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function waitUntil(predicate: () => boolean, timeoutMs = 3000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return true;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	return predicate();
}

test("captures stdout and reports a zero exit code", async () => {
	const runner = new ProcessRunner();
	let output = "";
	const proc = runner.start({ command: "printf hello", cwd: process.cwd() }, { onData: (chunk) => (output += chunk.toString()) });
	const info = await proc.exited;
	assert.equal(info.exitCode, 0);
	assert.equal(output, "hello");
});

test("captures stderr and reports a non-zero exit code", async () => {
	const runner = new ProcessRunner();
	let output = "";
	const proc = runner.start({ command: "printf oops >&2; exit 3", cwd: process.cwd() }, {
		onData: (chunk) => (output += chunk.toString()),
	});
	const info = await proc.exited;
	assert.equal(info.exitCode, 3);
	assert.equal(output, "oops");
});

test("the runner forgets processes once they exit", async () => {
	const runner = new ProcessRunner();
	const proc = runner.start({ command: "true", cwd: process.cwd() });
	assert.equal(runner.runningCount, 1);
	await proc.exited;
	assert.equal(runner.runningCount, 0);
});

test("kill terminates a running process", async () => {
	const runner = new ProcessRunner({ graceMs: 300 });
	const proc = runner.start({ command: "sleep 30", cwd: process.cwd() });
	assert.ok(await waitUntil(() => isAlive(proc.pid)));
	await proc.kill();
	const info = await proc.exited;
	assert.ok(info.exitCode !== 0 || info.signal !== null);
	assert.ok(await waitUntil(() => !isAlive(proc.pid)));
});

test("kill tears down the whole process group, not just the shell", async () => {
	const runner = new ProcessRunner({ graceMs: 300 });
	let grandchild = 0;
	let buffered = "";
	const proc = runner.start({ command: "sleep 30 & echo $!; wait", cwd: process.cwd() }, {
		onData: (chunk) => {
			buffered += chunk.toString();
			const match = /(\d+)/.exec(buffered);
			if (match) grandchild = Number(match[1]);
		},
	});

	try {
		assert.ok(await waitUntil(() => grandchild > 0), "expected the grandchild pid on stdout");
		assert.ok(isAlive(grandchild), "grandchild should be running");
		await proc.kill();
		assert.ok(await waitUntil(() => !isAlive(grandchild)), "grandchild should be dead after kill");
	} finally {
		if (grandchild > 0) {
			try {
				process.kill(grandchild, "SIGKILL");
			} catch {
				// already gone
			}
		}
	}
});

test("a timeout kills the process and is reported", async () => {
	const runner = new ProcessRunner({ graceMs: 300 });
	const proc = runner.start({ command: "sleep 30", cwd: process.cwd(), timeoutMs: 100 });
	const info = await proc.exited;
	assert.equal(info.timedOut, true);
	assert.equal(proc.timedOut, true);
});

test("killAll terminates every tracked process", async () => {
	const runner = new ProcessRunner({ graceMs: 300 });
	const first = runner.start({ command: "sleep 30", cwd: process.cwd() });
	const second = runner.start({ command: "sleep 30", cwd: process.cwd() });
	assert.equal(runner.runningCount, 2);

	await runner.killAll();
	await first.exited;
	await second.exited;
	assert.ok(await waitUntil(() => !isAlive(first.pid) && !isAlive(second.pid)));
});
