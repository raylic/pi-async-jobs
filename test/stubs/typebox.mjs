// Minimal stand-in for the `typebox` schema builder. Tests only care that a
// schema object exists; nothing validates against it.
const make = (kind) => (options) => ({ kind, ...(options ?? {}) });

export const Type = {
	Object: (properties) => ({ kind: "object", properties }),
	String: make("string"),
	Number: make("number"),
	Boolean: make("boolean"),
	Optional: (schema) => ({ kind: "optional", schema }),
};
