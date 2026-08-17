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
import z from '@deepseek-ai/schemastery';
export const name = 'tool-bulkhead';
export const Config = z.object({
    defaults: z.object({
        maxConcurrent: z.number(),
        maxQueue: z.number(),
        queueTimeout: z.number(),
        rejectWhenFull: z.boolean(),
    }),
    rules: z.array(z.object({
        tool: z.string(),
        domain: z.string(),
        tools: z.array(z.string()),
        maxConcurrent: z.number(),
        maxQueue: z.number(),
        queueTimeout: z.number(),
        rejectWhenFull: z.boolean(),
    })),
});
/** Structured error codes (see ARCHITECTURE.md §②). */
const REJECTED = 'BULKHEAD_REJECTED';
const QUEUE_TIMEOUT = 'BULKHEAD_QUEUE_TIMEOUT';
const ABORTED = 'BULKHEAD_ABORTED';
/** Compile one `*`-wildcard tool pattern to an anchored RegExp (every other regex metacharacter is matched literally). */
function wildcardToRegExp(pattern) {
    const escaped = pattern.replace(/[|\\{}()[\]^$+?.]/g, String.raw `\$&`);
    return new RegExp(`^${escaped.replaceAll('*', '.*')}$`);
}
/** Build one structured `isError` tool result (same shape as dsh-chaos). */
function bulkheadError(message, code, errorName) {
    return {
        isError: true,
        content: [{ type: 'text', text: `Error: ${message}` }],
        error: { message, info: { name: errorName, code } },
    };
}
/** Fail-loud validation of one limits block (rule or defaults). */
function assertLimits(limits, label) {
    if (limits === undefined)
        return;
    if (limits.maxConcurrent !== undefined && (!Number.isInteger(limits.maxConcurrent) || limits.maxConcurrent < 1)) {
        throw new Error(`dsh-tool-bulkhead: invalid ${label} maxConcurrent ${limits.maxConcurrent} — must be an integer >= 1`);
    }
    if (limits.maxQueue !== undefined && (!Number.isInteger(limits.maxQueue) || limits.maxQueue < 1)) {
        throw new Error(`dsh-tool-bulkhead: invalid ${label} maxQueue ${limits.maxQueue} — must be an integer >= 1`);
    }
    if (limits.queueTimeout !== undefined && (!Number.isInteger(limits.queueTimeout) || limits.queueTimeout < 0)) {
        throw new Error(`dsh-tool-bulkhead: invalid ${label} queueTimeout ${limits.queueTimeout} — must be a non-negative integer (ms)`);
    }
    if (limits.rejectWhenFull !== undefined && typeof limits.rejectWhenFull !== 'boolean') {
        throw new Error(`dsh-tool-bulkhead: invalid ${label} rejectWhenFull — must be a boolean`);
    }
}
const BUILTIN = { maxConcurrent: 8, maxQueue: 50, queueTimeout: undefined, rejectWhenFull: false };
/** Merge an optional limits block over a base. */
function resolveLimits(base, overrides) {
    if (overrides === undefined)
        return base;
    return {
        maxConcurrent: overrides.maxConcurrent ?? base.maxConcurrent,
        maxQueue: overrides.maxQueue ?? base.maxQueue,
        queueTimeout: overrides.queueTimeout ?? base.queueTimeout,
        rejectWhenFull: overrides.rejectWhenFull ?? base.rejectWhenFull,
    };
}
/** Compile one rule; fail-loud on mutually exclusive / empty fields. */
function compileRule(rule, index, defaults) {
    const hasTool = rule.tool !== undefined;
    // schemastery normalization injects an empty `tools: []` for tool-only
    // rules, so an empty array must count as "no group declared".
    const hasGroup = rule.domain !== undefined || ((rule.tools ?? []).length > 0);
    if (hasTool === hasGroup) {
        throw new Error(`dsh-tool-bulkhead: rule #${index + 1} must declare exactly one of \`tool\` or \`domain\` + \`tools\``);
    }
    assertLimits(rule, `rule #${index + 1}`);
    const limits = resolveLimits(defaults, rule);
    if (hasTool) {
        const regex = wildcardToRegExp(rule.tool);
        return {
            matches: (name) => regex.test(name),
            keyOf: (name) => `tool:${name}`,
            limits,
        };
    }
    const patterns = rule.tools.map(wildcardToRegExp);
    if (patterns.length === 0) {
        throw new Error(`dsh-tool-bulkhead: rule #${index + 1} \`domain\` requires a non-empty \`tools\` list`);
    }
    const groupKey = rule.domain;
    return {
        matches: (name) => patterns.some((regex) => regex.test(name)),
        keyOf: () => `group:${groupKey}`,
        limits,
    };
}
/**
 * Install the bulkhead guard.
 * @param ctx - plugin context; listeners are scoped to it and disposed with it.
 * @param config - validated {@link Config}; misconfiguration fails loud at load.
 */
export function apply(ctx, config) {
    assertLimits(config.defaults, 'defaults');
    const defaults = resolveLimits(BUILTIN, config.defaults);
    const rules = (config.rules ?? []).map((rule, index) => compileRule(rule, index, defaults));
    const domains = new Map();
    const emit = (event, ...args) => {
        ctx.emit(event, ...args);
    };
    /** Run one call now, then hand the freed slot to the FIFO queue head. */
    const executeNow = (domain, key, exec, run) => {
        domain.inFlight += 1;
        emit('bulkhead/acquired', { domain: key, tool: exec.name, inFlight: domain.inFlight });
        const promise = run();
        // Attach both handlers so the derived promise never rejects unhandled;
        // the original `promise` is what the caller awaits.
        promise.then(() => release(), () => release());
        return promise;
        function release() {
            domain.inFlight -= 1;
            emit('bulkhead/released', { domain: key, tool: exec.name, inFlight: domain.inFlight });
            const waiter = domain.queue.shift();
            if (waiter === undefined)
                return;
            waiter.settled = true;
            if (waiter.timer !== undefined)
                clearTimeout(waiter.timer);
            waiter.exec.signal.removeEventListener('abort', waiter.abortListener);
            waiter.resolve(executeNow(domain, key, waiter.exec, waiter.run));
        }
    };
    /** Wait for a free slot, bounded by queueTimeout and the caller's abort signal. */
    const enqueue = (domain, key, exec, run) => {
        return new Promise((resolve) => {
            const waiter = {
                exec, run, resolve,
                timer: undefined,
                abortListener: () => { },
                settled: false,
            };
            waiter.abortListener = () => {
                if (waiter.settled)
                    return;
                waiter.settled = true;
                const index = domain.queue.indexOf(waiter);
                if (index >= 0)
                    domain.queue.splice(index, 1);
                if (waiter.timer !== undefined)
                    clearTimeout(waiter.timer);
                resolve(bulkheadError(`bulkhead call aborted while queued in domain \`${key}\``, ABORTED, 'BulkheadAborted'));
            };
            exec.signal.addEventListener('abort', waiter.abortListener, { once: true });
            const timeout = domain.limits.queueTimeout;
            if (timeout !== undefined) {
                waiter.timer = setTimeout(() => {
                    if (waiter.settled)
                        return;
                    waiter.settled = true;
                    const index = domain.queue.indexOf(waiter);
                    if (index >= 0)
                        domain.queue.splice(index, 1);
                    exec.signal.removeEventListener('abort', waiter.abortListener);
                    emit('bulkhead/timed-out', { domain: key, tool: exec.name, queueTimeout: timeout });
                    resolve(bulkheadError(`bulkhead call waited ${timeout}ms in domain \`${key}\` without a free slot — timing out`, QUEUE_TIMEOUT, 'BulkheadQueueTimeout'));
                }, timeout);
            }
            domain.queue.push(waiter);
            emit('bulkhead/queued', { domain: key, tool: exec.name, queueDepth: domain.queue.length });
        });
    };
    /** Route one call through its domain's scheduler (execute / queue / reject). */
    const schedule = (domain, key, exec, run) => {
        if (exec.signal.aborted) {
            return Promise.resolve(bulkheadError(`bulkhead call for \`${exec.name}\` was aborted before it could be scheduled`, ABORTED, 'BulkheadAborted'));
        }
        if (domain.inFlight < domain.limits.maxConcurrent) {
            return executeNow(domain, key, exec, run);
        }
        if (domain.queue.length < domain.limits.maxQueue || !domain.limits.rejectWhenFull) {
            return enqueue(domain, key, exec, run);
        }
        emit('bulkhead/rejected', { domain: key, tool: exec.name, queueDepth: domain.queue.length });
        return Promise.resolve(bulkheadError(`bulkhead domain \`${key}\` is full (${domain.limits.maxConcurrent} executing, ${domain.limits.maxQueue} queued) — refusing the call`, REJECTED, 'BulkheadRejected'));
    };
    ctx.on('tools/execute', async (exec, next) => {
        const rule = rules.find((candidate) => candidate.matches(exec.name));
        if (rule === undefined)
            return next();
        const key = rule.keyOf(exec.name);
        let domain = domains.get(key);
        if (domain === undefined) {
            domain = { limits: rule.limits, inFlight: 0, queue: [] };
            domains.set(key, domain);
        }
        return schedule(domain, key, exec, () => next());
    });
}
