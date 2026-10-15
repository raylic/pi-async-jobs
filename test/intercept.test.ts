import test from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_SLOW_COMMAND_PATTERNS } from "../config.ts";
import { buildBlockReason, matchSlowCommand, SlowCommandGuard, splitSegments } from "../intercept.ts";

const patterns = DEFAULT_SLOW_COMMAND_PATTERNS.map((source) => new RegExp(source));

function matches(command: string): boolean {
	return matchSlowCommand(command, patterns) !== undefined;
}

test("the whitelist catches the obvious long-running command families", () => {
	for (const command of [
		"npm run build",
		"pnpm install",
		"yarn test",
		"docker build -t app .",
		"docker compose up -d",
		"terraform apply",
		"pytest",
		"python3 -m pytest -q",
		"cargo build --release",
		"go test ./...",
		"make",
		"./gradlew build",
		"vite build",
		"next dev",
		"tail -f server.log",
		"sleep 30",
		"ffmpeg -i in.mp4 out.mp4",
		"sudo docker build .",
	]) {
		assert.ok(matches(command), `expected a match: ${command}`);
	}
});

test("the whitelist stays narrow: quick commands are left alone", () => {
	for (const command of [
		"ls -la",
		"git status",
		"git commit -m 'x'",
		"npm ls",
		"npm view react version",
		"cat package.json",
		"rg TODO src",
		"echo 'make it so'",
		"grep -rn 'sleep' .",
		"tail -n 20 log.txt",
		"python3 script.py",
		"docker ps",
	]) {
		assert.ok(!matches(command), `expected NO match: ${command}`);
	}
});

test("segments are matched individually", () => {
	assert.equal(splitSegments("cd app && npm run build").length, 2);
	assert.ok(matches("cd app && npm run build"));
	assert.ok(matches("npm ci; npm run build"));
	assert.ok(!matches("cd app && npm ls"));
});

test("commands the caller already backgrounded are left alone", () => {
	assert.ok(!matches("npm run build &"));
	assert.ok(!matches("nohup npm run build"));
	assert.ok(!matches("setsid pytest"));
});

test("buildBlockReason tells the model exactly what to do", () => {
	const reason = buildBlockReason("^npm", "npm run build");
	assert.match(reason, /job_start/);
	assert.match(reason, /on_done/);
	assert.match(reason, /npm run build/);
	assert.match(reason, /原样重发/, "the escape hatch must be documented");
});

test("the guard blocks once and lets the retry through", () => {
	const guard = new SlowCommandGuard({ patterns: DEFAULT_SLOW_COMMAND_PATTERNS });
	assert.ok(guard.shouldBlock("npm run build"));
	assert.equal(guard.shouldBlock("npm run build"), undefined, "the retry must pass");
	assert.equal(guard.shouldBlock("ls"), undefined);
});

test("nested calls are never blocked", () => {
	const guard = new SlowCommandGuard({ patterns: DEFAULT_SLOW_COMMAND_PATTERNS });
	assert.equal(guard.shouldBlock("npm run build", { nested: true }), undefined);
});

test("the guard forgets a warned command once the memo expires", () => {
	let now = 1_000;
	const guard = new SlowCommandGuard({
		patterns: DEFAULT_SLOW_COMMAND_PATTERNS,
		memoMs: 1000,
		now: () => now,
	});
	assert.ok(guard.shouldBlock("pytest"));
	assert.equal(guard.shouldBlock("pytest"), undefined);
	now += 2000;
	assert.ok(guard.shouldBlock("pytest"), "an expired memo may be warned again");
});

test("the guard stays bounded and tolerates bad patterns", () => {
	const guard = new SlowCommandGuard({ patterns: ["[unclosed", "^make"], maxEntries: 2 });
	assert.equal(guard.shouldBlock("pytest"), undefined, "a malformed pattern is ignored");
	assert.ok(guard.shouldBlock("make"));
	assert.ok(guard.shouldBlock("make all"));
	assert.ok(guard.shouldBlock("make test"));
	// ``make`` was the oldest memo entry and got evicted, so it may be warned
	// again; the two most recent ones are still remembered.
	assert.ok(guard.shouldBlock("make"));
	assert.equal(guard.shouldBlock("make test"), undefined, "the newest warning still holds");
});

test("an empty pattern list disables interception", () => {
	const guard = new SlowCommandGuard({ patterns: [] });
	assert.equal(guard.shouldBlock("npm run build"), undefined);
});
