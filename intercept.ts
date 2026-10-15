/**
 * Soft interception of obviously-long `bash` commands.
 *
 * This is a *correction* mechanism, not a detection mechanism: it fires exactly
 * where the model should already have known a command is long. Its value is
 * that the model re-issues the command through `job_start`, which means the
 * `on_done` continuation gets filled in — something a silent takeover cannot do.
 *
 * Anything the whitelist misses is left to the timeout takeover in
 * `bashbridge.ts`, which cannot misfire. Keeping this list narrow is deliberate:
 * a false positive costs a wasted model round-trip.
 */

export interface SlowCommandGuardOptions {
  patterns: string[];
  now?: () => number;
  /** How long a warned command is remembered before it may be intercepted again. */
  memoMs?: number;
  maxEntries?: number;
}

const DEFAULT_MEMO_MS = 300_000;
const DEFAULT_MAX_ENTRIES = 64;

/** Split a shell line on the operators that introduce a new command. */
export function splitSegments(command: string): string[] {
	return command
		.split(/\n|&&|\|\||;|\|/)
		.map((segment) => segment.trim())
		.filter((segment) => segment.length > 0);
}

/** First whitelist rule matching any segment, or undefined. */
export function matchSlowCommand(command: string, compiled: RegExp[]): string | undefined {
	const trimmed = command.trim();
	if (trimmed.length === 0) return undefined;
	// Already backgrounded by the caller: bash returns immediately anyway.
	if (/&\s*$/.test(trimmed)) return undefined;

	for (const segment of splitSegments(trimmed)) {
		if (/^(nohup|setsid)\b/.test(segment)) continue;
		for (const pattern of compiled) {
			if (pattern.test(segment)) return pattern.source;
		}
	}
	return undefined;
}

function compile(patterns: string[]): RegExp[] {
	const compiled: RegExp[] = [];
	for (const source of patterns) {
		try {
			compiled.push(new RegExp(source));
		} catch {
			// A malformed user-supplied pattern must not break interception.
		}
	}
	return compiled;
}

/** The block message handed back to the model. */
export function buildBlockReason(rule: string, command: string): string {
	return [
		`这条命令看起来是长任务，已拦下，没有执行（规则: ${rule}）。`,
		`命令: ${command}`,
		"请不要用 bash 跑它。改用 job_start，并填写 on_done 说明结果回来后你要做什么：",
		`  job_start({ "command": ${JSON.stringify(command)}, "on_done": "<拿到结果后你要做什么>" })`,
		"如果你确认它其实很快，就原样重发这条 bash 调用，这次会放行。",
	].join("\n");
}

/**
 * Decides whether a bash call should be intercepted, and remembers what it
 * warned so the retry passes through (the escape hatch that prevents a loop).
 */
export class SlowCommandGuard {
	private readonly compiled: RegExp[];
	private readonly warned = new Map<string, number>();
	private readonly now: () => number;
	private readonly memoMs: number;
	private readonly maxEntries: number;

	constructor(options: SlowCommandGuardOptions) {
		this.compiled = compile(options.patterns);
		this.now = options.now ?? Date.now;
		this.memoMs = options.memoMs ?? DEFAULT_MEMO_MS;
		this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
	}

	/**
	 * The matched rule when this call should be blocked, otherwise undefined.
	 * Marks the command as warned so an immediate retry is allowed through.
	 */
	shouldBlock(command: string, options: { nested?: boolean } = {}): string | undefined {
		// Calls a script made (codemode, other tools) are not the model's bash
		// call; blocking them would surface a confusing error inside the script.
		if (options.nested) return undefined;
		if (this.compiled.length === 0) return undefined;

		const key = command.trim();
		this.prune();

		const rule = matchSlowCommand(command, this.compiled);
		if (!rule) return undefined;
		if (this.warned.has(key)) return undefined;

		this.warned.set(key, this.now());
		if (this.warned.size > this.maxEntries) {
			const oldest = this.warned.keys().next();
			if (!oldest.done) this.warned.delete(oldest.value);
		}
		return rule;
	}

	private prune(): void {
		if (this.memoMs <= 0) {
			this.warned.clear();
			return;
		}
		const cutoff = this.now() - this.memoMs;
		for (const [key, at] of this.warned) {
			if (at < cutoff) this.warned.delete(key);
		}
	}
}
