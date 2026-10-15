// Minimal stand-in for the parts of the pi runtime that index.ts imports as
// values. Tests only need a registrable tool definition with the bash shape.
export function createBashToolDefinition(_cwd, _options) {
	return {
		name: "bash",
		label: "bash",
		description: "Execute a bash command in the current working directory.",
		promptSnippet: "Execute bash commands",
		parameters: { kind: "object", properties: {} },
		outputSchema: { kind: "object" },
		execute: async () => ({
			content: [{ type: "text", text: "(stub bash output)" }],
			details: undefined,
		}),
	};
}
