// Resolve-only module hook: redirects the pi-provided aliases to stubs so the
// composition root can be smoke-tested outside the pi runtime.
const STUBS = new Map([
	["typebox", new URL("./stubs/typebox.mjs", import.meta.url).href],
	["@earendil-works/pi-coding-agent", new URL("./stubs/pi-coding-agent.mjs", import.meta.url).href],
]);

export async function resolve(specifier, context, nextResolve) {
	const stub = STUBS.get(specifier);
	if (stub) return { url: stub, shortCircuit: true, format: "module" };
	return nextResolve(specifier, context);
}
