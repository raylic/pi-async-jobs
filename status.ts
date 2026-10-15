/**
 * Footer status line for running jobs.
 *
 * UI-only and event-driven: refreshed whenever job state changes, never on a
 * timer. Because there is no tick, the text deliberately omits elapsed time —
 * a frozen "running 2m14s" would look live and be wrong.
 */

import type { JobRecord } from "./types.ts";

export const STATUS_KEY = "async-jobs";
const MAX_COMMAND_CHARS = 48;

/** Collapse whitespace and clip, so one line never wraps the footer. */
export function truncateCommand(command: string): string {
	const oneLine = command.replace(/\s+/g, " ").trim();
	if (oneLine.length <= MAX_COMMAND_CHARS) return oneLine;
	return `${oneLine.slice(0, MAX_COMMAND_CHARS - 1)}…`;
}

/** The footer text, or undefined when nothing is running. */
export function formatStatusText(records: JobRecord[]): string | undefined {
	const running = records.filter((record) => record.status === "running");
	if (running.length === 0) return undefined;
	if (running.length === 1) {
		return `⚙ ${running[0].id} 运行中: ${truncateCommand(running[0].command)}`;
	}
	return `⚙ ${running.length} 个任务运行中 (${running.map((record) => record.id).join(" ")})`;
}

export interface StatusPublisherDeps {
	records: () => JobRecord[];
	sink: (text: string | undefined) => void;
}

/** Publishes the status line, skipping identical values. */
export class StatusPublisher {
	private readonly deps: StatusPublisherDeps;
	private published: string | undefined;
	private initialized = false;

	constructor(deps: StatusPublisherDeps) {
		this.deps = deps;
	}

	refresh(): void {
		const text = formatStatusText(this.deps.records());
		if (this.initialized && text === this.published) return;
		this.published = text;
		this.initialized = true;
		this.deps.sink(text);
	}

	clear(): void {
		if (this.initialized && this.published === undefined) return;
		this.published = undefined;
		this.initialized = true;
		this.deps.sink(undefined);
	}
}
