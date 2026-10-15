import { register } from "node:module";
import test from "node:test";
import assert from "node:assert/strict";

register("./hooks.mjs", import.meta.url);

test("the extension registers its tools, command and lifecycle hooks", async () => {
	const mod = await import("../index.ts");
	const tools: any[] = [];
	const commands: string[] = [];
	const events: string[] = [];
	const fakePi: any = {
		registerTool: (tool: unknown) => tools.push(tool),
		registerCommand: (name: string) => commands.push(name),
		on: (event: string) => {
			events.push(event);
			return () => {};
		},
		sendMessage: () => {},
		getSettings: () => ({}),
	};

	mod.default(fakePi);

	assert.deepEqual(
		tools.map((tool) => tool.name),
		["job_start", "job_read", "job_list", "job_cancel"],
	);
	for (const tool of tools) {
		assert.equal(typeof tool.description, "string", `${tool.name} needs a description`);
		assert.equal(typeof tool.label, "string", `${tool.name} needs a label`);
		assert.ok(tool.parameters, `${tool.name} needs a parameter schema`);
		assert.equal(typeof tool.execute, "function", `${tool.name} needs an execute function`);
	}

	const start = tools.find((tool) => tool.name === "job_start");
	assert.ok(start.promptGuidelines?.[0]?.includes("on_done"), "job_start must steer the model");

	assert.deepEqual(commands, ["job"]);
	assert.ok(events.includes("session_start"));
	assert.ok(events.includes("agent_before_settle"));
	assert.ok(events.includes("session_shutdown"));
});

test("job_start reports a started job and job_read lists it", async () => {
	const mod = await import("../index.ts");
	const tools = new Map<string, any>();
	const fakePi: any = {
		registerTool: (tool: any) => tools.set(tool.name, tool),
		registerCommand: () => {},
		on: () => () => {},
		sendMessage: () => {},
		getSettings: () => ({}),
	};
	mod.default(fakePi);

	const ctx: any = { cwd: process.cwd(), isIdle: () => true };
	const started = await tools.get("job_start").execute("call-1", {
		command: "printf background",
		on_done: "read the output",
	}, undefined, undefined, ctx);
	assert.equal(started.details.ok, true);
	assert.match(started.content[0].text, /任务已启动/);

	const listed = await tools.get("job_list").execute("call-2", {}, undefined, undefined, ctx);
	assert.match(listed.content[0].text, /j1/);

	// Let the background process finish so nothing is left behind.
	await new Promise((resolve) => setTimeout(resolve, 100));
	await tools.get("job_cancel").execute("call-3", { id: "j1" }, undefined, undefined, ctx);
});
