import test from "node:test";
import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";

import { OutputBuffer, formatSize, truncateTail } from "../buffer.ts";

test("formatSize", () => {
	assert.equal(formatSize(512), "512B");
	assert.equal(formatSize(2048), "2.0KB");
	assert.equal(formatSize(3 * 1024 * 1024), "3.0MB");
});

test("truncateTail keeps the end of long content", () => {
	const content = "0123456789".repeat(10); // 100 bytes
	const result = truncateTail(content, { maxLines: 1000, maxBytes: 10 });
	assert.equal(result.truncated, true);
	assert.equal(result.truncatedBy, "bytes");
	assert.equal(result.content, "0123456789");
});

test("truncateTail keeps the last N lines", () => {
	const content = ["a", "b", "c", "d", "e"].join("\n");
	const result = truncateTail(content, { maxLines: 2, maxBytes: 1024 });
	assert.equal(result.truncated, true);
	assert.equal(result.truncatedBy, "lines");
	assert.equal(result.content, "d\ne");
});

test("small output is not truncated and never spills", async () => {
	const buffer = new OutputBuffer({ maxLines: 100, maxBytes: 1024 });
	buffer.append(Buffer.from("hello\n"));
	buffer.append(Buffer.from("world\n"));
	await buffer.close();

	const snapshot = buffer.snapshot();
	assert.equal(snapshot.truncated, false);
	assert.equal(snapshot.fullOutputPath, undefined);
	assert.equal(snapshot.output, "hello\nworld\n");
	assert.equal(snapshot.totalBytes, 12);
	assert.equal(snapshot.totalLines, 2);
	await buffer.dispose();
});

test("long output keeps the tail and spills the full stream to a file", async () => {
	const buffer = new OutputBuffer({ maxLines: 1000, maxBytes: 32 });
	const full = "a".repeat(10) + "b".repeat(10) + "c".repeat(10) + "d".repeat(10);
	buffer.append(Buffer.from(full));
	await buffer.close();

	const snapshot = buffer.snapshot();
	assert.equal(snapshot.truncated, true);
	assert.equal(snapshot.truncatedBy, "bytes");
	assert.equal(Buffer.byteLength(snapshot.output), 32);
	assert.ok(snapshot.output.endsWith("d".repeat(10)));
	assert.ok(snapshot.fullOutputPath, "expected a spill path");
	assert.equal(await readFile(snapshot.fullOutputPath!, "utf-8"), full);

	await buffer.dispose();
	await assert.rejects(stat(snapshot.fullOutputPath!));
});

test("line limit triggers truncation and spill", async () => {
	const buffer = new OutputBuffer({ maxLines: 3, maxBytes: 1024 * 1024 });
	buffer.append(Buffer.from("1\n2\n3\n4\n5\n"));
	await buffer.close();

	const snapshot = buffer.snapshot();
	assert.equal(snapshot.truncated, true);
	assert.equal(snapshot.truncatedBy, "lines");
	assert.equal(snapshot.output, "3\n4\n5");
	await buffer.dispose();
});

test("decodes multibyte characters split across chunks", async () => {
	const buffer = new OutputBuffer();
	const bytes = Buffer.from("héllo\n", "utf-8");
	buffer.append(bytes.subarray(0, 2)); // splits "é"
	buffer.append(bytes.subarray(2));
	await buffer.close();

	const snapshot = buffer.snapshot();
	assert.equal(snapshot.output, "héllo\n");
	assert.ok(!snapshot.output.includes("\uFFFD"), "should not contain replacement characters");
	await buffer.dispose();
});

test("snapshot works while the job is still running", () => {
	const buffer = new OutputBuffer();
	buffer.append(Buffer.from("partial output"));
	const snapshot = buffer.snapshot();
	assert.equal(snapshot.output, "partial output");
	assert.equal(snapshot.truncated, false);
});

test("dispose removes the spill file and stops recreating it", async () => {
	const buffer = new OutputBuffer({ maxBytes: 8 });
	buffer.append(Buffer.from("0123456789abcdef"));
	const path = buffer.snapshot().fullOutputPath;
	assert.ok(path);
	await buffer.dispose();
	await assert.rejects(stat(path!));
	// A snapshot after dispose must not resurrect the file.
	await buffer.dispose();
	assert.equal(buffer.path, undefined);
});
