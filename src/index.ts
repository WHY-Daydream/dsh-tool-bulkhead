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

import type { Context, Events } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'

export const name = 'tool-bulkhead'

/** Concurrency limits of one isolation domain; every field is optional and falls back to `defaults`. */
export interface BulkheadLimits {
  /** Max concurrently executing calls in the domain (default 8). */
  maxConcurrent?: number
  /** Max FIFO-queued calls beyond the executing ones (default 50). */
  maxQueue?: number
  /** Max milliseconds a queued call waits before `BULKHEAD_QUEUE_TIMEOUT`; absent = wait forever. */
  queueTimeout?: number
  /** At queue capacity: `true` rejects with `BULKHEAD_REJECTED`, `false` keeps waiting. */
  rejectWhenFull?: boolean
}

/** One opt-in rule: `tool` (per-tool domain) XOR `domain` + `tools` (per-provider domain). */
export interface BulkheadRule extends BulkheadLimits {
  /** `*`-wildcard tool pattern; each matched tool gets its own domain. */
  tool?: string
  /** Named shared domain (per-provider isolation) for the `tools` patterns. */
  domain?: string
  /** `*`-wildcard tool patterns sharing the `domain`. */
  tools?: string[]
}

/** Plugin config. */
export interface Config {
  /** Fallback limits for rules that omit a field. */
  defaults?: BulkheadLimits
  /** Opt-in rules, first match wins; an empty list leaves the plugin inert. */
  rules?: BulkheadRule[]
}

export const Config: z<Config> = z.object({
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
})

/** Structured error codes (see ARCHITECTURE.md §②). */
const REJECTED = 'BULKHEAD_REJECTED'
const QUEUE_TIMEOUT = 'BULKHEAD_QUEUE_TIMEOUT'
const ABORTED = 'BULKHEAD_ABORTED'

/** Metric payload shared by every `bulkhead/*` event. */
export interface BulkheadMetricData {
  /** The isolation-domain key (per-tool `tool:<name>` or per-provider `group:<name>`). */
  readonly domain: string
  /** The tool name whose call triggered the event. */
  readonly tool: string
  /** Executing count after the transition (acquired / released). */
  readonly inFlight?: number
  /** Queue depth after enqueue. */
  readonly queueDepth?: number
  /** The configured queue timeout that expired (timed-out). */
  readonly queueTimeout?: number
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    'bulkhead/queued'(data: BulkheadMetricData): void
    'bulkhead/acquired'(data: BulkheadMetricData): void
    'bulkhead/released'(data: BulkheadMetricData): void
    'bulkhead/rejected'(data: BulkheadMetricData): void
    'bulkhead/timed-out'(data: BulkheadMetricData): void
  }
}

/** Metric event names emitted by this plugin. */
export type BulkheadEvent =
  | 'bulkhead/queued'
  | 'bulkhead/acquired'
  | 'bulkhead/released'
  | 'bulkhead/rejected'
  | 'bulkhead/timed-out'

/** Compile one `*`-wildcard tool pattern to an anchored RegExp (every other regex metacharacter is matched literally). */
function wildcardToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[|\\{}()[\]^$+?.]/g, String.raw`\$&`)
  return new RegExp(`^${escaped.replaceAll('*', '.*')}$`)
}

/** Build one structured `isError` tool result (same shape as dsh-chaos). */
function bulkheadError(message: string, code: string, errorName: string): ToolExecutionResult {
  return {
    isError: true,
    content: [{ type: 'text', text: `Error: ${message}` }],
    error: { message, info: { name: errorName, code } },
  }
}

/** Fully resolved limits (built-ins ← `defaults` ← rule). */
interface ResolvedLimits {
  maxConcurrent: number
  maxQueue: number
  queueTimeout: number | undefined
  rejectWhenFull: boolean
}

/** Fail-loud validation of one limits block (rule or defaults). */
function assertLimits(limits: BulkheadLimits | undefined, label: string): void {
  if (limits === undefined) return
  if (limits.maxConcurrent !== undefined && (!Number.isInteger(limits.maxConcurrent) || limits.maxConcurrent < 1)) {
    throw new Error(`dsh-tool-bulkhead: invalid ${label} maxConcurrent ${limits.maxConcurrent} — must be an integer >= 1`)
  }
  if (limits.maxQueue !== undefined && (!Number.isInteger(limits.maxQueue) || limits.maxQueue < 1)) {
    throw new Error(`dsh-tool-bulkhead: invalid ${label} maxQueue ${limits.maxQueue} — must be an integer >= 1`)
  }
  if (limits.queueTimeout !== undefined && (!Number.isInteger(limits.queueTimeout) || limits.queueTimeout < 0)) {
    throw new Error(`dsh-tool-bulkhead: invalid ${label} queueTimeout ${limits.queueTimeout} — must be a non-negative integer (ms)`)
  }
  if (limits.rejectWhenFull !== undefined && typeof limits.rejectWhenFull !== 'boolean') {
    throw new Error(`dsh-tool-bulkhead: invalid ${label} rejectWhenFull — must be a boolean`)
  }
}

const BUILTIN: ResolvedLimits = { maxConcurrent: 8, maxQueue: 50, queueTimeout: undefined, rejectWhenFull: false }

/** Merge an optional limits block over a base. */
function resolveLimits(base: ResolvedLimits, overrides: BulkheadLimits | undefined): ResolvedLimits {
  if (overrides === undefined) return base
  return {
    maxConcurrent: overrides.maxConcurrent ?? base.maxConcurrent,
    maxQueue: overrides.maxQueue ?? base.maxQueue,
    queueTimeout: overrides.queueTimeout ?? base.queueTimeout,
    rejectWhenFull: overrides.rejectWhenFull ?? base.rejectWhenFull,
  }
}

/** One compiled rule: match + domain-key resolution + resolved limits. */
interface CompiledRule {
  matches: (toolName: string) => boolean
  keyOf: (toolName: string) => string
  limits: ResolvedLimits
}

/** One queued call awaiting a free slot. */
interface Waiter {
  exec: ToolExecution
  run: () => Promise<ToolExecutionResult>
  resolve: (result: ToolExecutionResult | PromiseLike<ToolExecutionResult>) => void
  timer: NodeJS.Timeout | undefined
  abortListener: () => void
  settled: boolean
}

/** One isolation domain: in-flight count + FIFO queue. */
interface Domain {
  limits: ResolvedLimits
  inFlight: number
  queue: Waiter[]
}

/** Compile one rule; fail-loud on mutually exclusive / empty fields. */
function compileRule(rule: BulkheadRule, index: number, defaults: ResolvedLimits): CompiledRule {
  const hasTool = rule.tool !== undefined
  // schemastery normalization injects an empty `tools: []` for tool-only
  // rules, so an empty array must count as "no group declared".
  const hasGroup = rule.domain !== undefined || ((rule.tools ?? []).length > 0)
  if (hasTool === hasGroup) {
    throw new Error(`dsh-tool-bulkhead: rule #${index + 1} must declare exactly one of \`tool\` or \`domain\` + \`tools\``)
  }
  assertLimits(rule, `rule #${index + 1}`)
  const limits = resolveLimits(defaults, rule)
  if (hasTool) {
    const regex = wildcardToRegExp(rule.tool as string)
    return {
      matches: (name) => regex.test(name),
      keyOf: (name) => `tool:${name}`,
      limits,
    }
  }
  const patterns = (rule.tools as string[]).map(wildcardToRegExp)
  if (patterns.length === 0) {
    throw new Error(`dsh-tool-bulkhead: rule #${index + 1} \`domain\` requires a non-empty \`tools\` list`)
  }
  const groupKey = rule.domain as string
  return {
    matches: (name) => patterns.some((regex) => regex.test(name)),
    keyOf: () => `group:${groupKey}`,
    limits,
  }
}

/**
 * Install the bulkhead guard.
 * @param ctx - plugin context; listeners are scoped to it and disposed with it.
 * @param config - validated {@link Config}; misconfiguration fails loud at load.
 */
export function apply(ctx: Context, config: Config): void {
  assertLimits(config.defaults, 'defaults')
  const defaults = resolveLimits(BUILTIN, config.defaults)
  const rules: CompiledRule[] = (config.rules ?? []).map((rule, index) => compileRule(rule, index, defaults))
  const domains = new Map<string, Domain>()

  const emit = (event: BulkheadEvent, ...args: Parameters<Events[BulkheadEvent]>): void => {
    ctx.emit(event, ...args)
  }

  /** Run one call now, then hand the freed slot to the FIFO queue head. */
  const executeNow = (domain: Domain, key: string, exec: ToolExecution, run: () => Promise<ToolExecutionResult>): Promise<ToolExecutionResult> => {
    domain.inFlight += 1
    emit('bulkhead/acquired', { domain: key, tool: exec.name, inFlight: domain.inFlight })
    const promise = run()
    // Attach both handlers so the derived promise never rejects unhandled;
    // the original `promise` is what the caller awaits.
    promise.then(
      () => release(),
      () => release(),
    )
    return promise

    function release(): void {
      domain.inFlight -= 1
      emit('bulkhead/released', { domain: key, tool: exec.name, inFlight: domain.inFlight })
      const waiter = domain.queue.shift()
      if (waiter === undefined) return
      waiter.settled = true
      if (waiter.timer !== undefined) clearTimeout(waiter.timer)
      waiter.exec.signal.removeEventListener('abort', waiter.abortListener)
      waiter.resolve(executeNow(domain, key, waiter.exec, waiter.run))
    }
  }

  /** Wait for a free slot, bounded by queueTimeout and the caller's abort signal. */
  const enqueue = (domain: Domain, key: string, exec: ToolExecution, run: () => Promise<ToolExecutionResult>): Promise<ToolExecutionResult> => {
    return new Promise<ToolExecutionResult>((resolve) => {
      const waiter: Waiter = {
        exec, run, resolve,
        timer: undefined,
        abortListener: () => {},
        settled: false,
      }
      waiter.abortListener = () => {
        if (waiter.settled) return
        waiter.settled = true
        const index = domain.queue.indexOf(waiter)
        if (index >= 0) domain.queue.splice(index, 1)
        if (waiter.timer !== undefined) clearTimeout(waiter.timer)
        resolve(bulkheadError(`bulkhead call aborted while queued in domain \`${key}\``, ABORTED, 'BulkheadAborted'))
      }
      exec.signal.addEventListener('abort', waiter.abortListener, { once: true })
      const timeout = domain.limits.queueTimeout
      if (timeout !== undefined) {
        waiter.timer = setTimeout(() => {
          if (waiter.settled) return
          waiter.settled = true
          const index = domain.queue.indexOf(waiter)
          if (index >= 0) domain.queue.splice(index, 1)
          exec.signal.removeEventListener('abort', waiter.abortListener)
          emit('bulkhead/timed-out', { domain: key, tool: exec.name, queueTimeout: timeout })
          resolve(bulkheadError(
            `bulkhead call waited ${timeout}ms in domain \`${key}\` without a free slot — timing out`,
            QUEUE_TIMEOUT,
            'BulkheadQueueTimeout',
          ))
        }, timeout)
      }
      domain.queue.push(waiter)
      emit('bulkhead/queued', { domain: key, tool: exec.name, queueDepth: domain.queue.length })
    })
  }

  /** Route one call through its domain's scheduler (execute / queue / reject). */
  const schedule = (domain: Domain, key: string, exec: ToolExecution, run: () => Promise<ToolExecutionResult>): Promise<ToolExecutionResult> => {
    if (exec.signal.aborted) {
      return Promise.resolve(bulkheadError(
        `bulkhead call for \`${exec.name}\` was aborted before it could be scheduled`,
        ABORTED,
        'BulkheadAborted',
      ))
    }
    if (domain.inFlight < domain.limits.maxConcurrent) {
      return executeNow(domain, key, exec, run)
    }
    if (domain.queue.length < domain.limits.maxQueue || !domain.limits.rejectWhenFull) {
      return enqueue(domain, key, exec, run)
    }
    emit('bulkhead/rejected', { domain: key, tool: exec.name, queueDepth: domain.queue.length })
    return Promise.resolve(bulkheadError(
      `bulkhead domain \`${key}\` is full (${domain.limits.maxConcurrent} executing, ${domain.limits.maxQueue} queued) — refusing the call`,
      REJECTED,
      'BulkheadRejected',
    ))
  }

  ctx.on('tools/execute', async (exec, next): Promise<ToolExecutionResult> => {
    const rule = rules.find((candidate) => candidate.matches(exec.name))
    if (rule === undefined) return next()
    const key = rule.keyOf(exec.name)
    let domain = domains.get(key)
    if (domain === undefined) {
      domain = { limits: rule.limits, inFlight: 0, queue: [] }
      domains.set(key, domain)
    }
    return schedule(domain, key, exec, () => next())
  })
}
