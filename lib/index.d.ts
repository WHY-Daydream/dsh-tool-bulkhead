/**
 * Bulkhead / concurrency-isolation guard for DeepSeek Harness tool calls.
 *
 * Configured tools (see ARCHITECTURE.md §②) get per-tool or per-provider
 * isolation domains: at most `maxConcurrent` calls execute at once, excess
 * calls queue FIFO up to `maxQueue`, a queued call waits at most
 * `queueTimeout`, and a full queue rejects immediately when `rejectWhenFull`
 * is set. Calls outside every rule pass through untouched.
 * @module @why-daydream/dsh-tool-bulkhead
 */
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
export declare const name = "tool-bulkhead";
/** Concurrency limits of one isolation domain; every field is optional and falls back to `defaults`. */
export interface BulkheadLimits {
    /** Max concurrently executing calls in the domain (default 8). */
    maxConcurrent?: number;
    /** Max FIFO-queued calls beyond the executing ones (default 50). */
    maxQueue?: number;
    /** Max milliseconds a queued call waits before `BULKHEAD_QUEUE_TIMEOUT`; absent = wait forever. */
    queueTimeout?: number;
    /** At queue capacity: `true` rejects with `BULKHEAD_REJECTED`, `false` keeps waiting. */
    rejectWhenFull?: boolean;
}
/** One opt-in rule: `tool` (per-tool domain) XOR `domain` + `tools` (per-provider domain). */
export interface BulkheadRule extends BulkheadLimits {
    /** `*`-wildcard tool pattern; each matched tool gets its own domain. */
    tool?: string;
    /** Named shared domain (per-provider isolation) for the `tools` patterns. */
    domain?: string;
    /** `*`-wildcard tool patterns sharing the `domain`. */
    tools?: string[];
}
/** Plugin config. */
export interface Config {
    /** Fallback limits for rules that omit a field. */
    defaults?: BulkheadLimits;
    /** Opt-in rules, first match wins; an empty list leaves the plugin inert. */
    rules?: BulkheadRule[];
}
export declare const Config: z<Config>;
/** Metric payload shared by every `bulkhead/*` event. */
export interface BulkheadMetricData {
    /** The isolation-domain key (per-tool `tool:<name>` or per-provider `group:<name>`). */
    readonly domain: string;
    /** The tool name whose call triggered the event. */
    readonly tool: string;
    /** Executing count after the transition (acquired / released). */
    readonly inFlight?: number;
    /** Queue depth after enqueue. */
    readonly queueDepth?: number;
    /** The configured queue timeout that expired (timed-out). */
    readonly queueTimeout?: number;
}
declare module '@deepseek-ai/cordis' {
    interface Events {
        'bulkhead/queued'(data: BulkheadMetricData): void;
        'bulkhead/acquired'(data: BulkheadMetricData): void;
        'bulkhead/released'(data: BulkheadMetricData): void;
        'bulkhead/rejected'(data: BulkheadMetricData): void;
        'bulkhead/timed-out'(data: BulkheadMetricData): void;
    }
}
/** Metric event names emitted by this plugin. */
export type BulkheadEvent = 'bulkhead/queued' | 'bulkhead/acquired' | 'bulkhead/released' | 'bulkhead/rejected' | 'bulkhead/timed-out';
/**
 * Install the bulkhead guard.
 * @param ctx - plugin context; listeners are scoped to it and disposed with it.
 * @param config - validated {@link Config}; misconfiguration fails loud at load.
 */
export declare function apply(ctx: Context, config: Config): void;
