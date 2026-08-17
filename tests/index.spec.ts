/**
 * Behavior suite for the dsh-tool-bulkhead guard: concurrency cap, FIFO
 * queuing, queue timeout, reject-on-full, per-tool / per-provider isolation,
 * defaults inheritance, transparent pass-through, abort-while-queued, slot
 * release after failure, fail-loud config validation, and metric events —
 * driven through the real tool registry (no network).
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CallId, type ContentBlock } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineContentToolFixture, type JsonValue } from '@deepseek-ai/dsh-tools'
import * as Bulkhead from '../src/index.js'
import type { Config, BulkheadEvent } from '../src/index.js'

let callSequence = 0
function nextCallId(): string {
  callSequence += 1
  return `c${callSequence}`
}

/** Boot the system-prompt + tool registry + the bulkhead plugin. */
async function harness(config: Config = {}): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(Bulkhead, config)
  return ctx
}

/** Register a side-effect tool whose body runs exactly once per real call. */
function registerTool(ctx: Context, name: string, body: () => ContentBlock[] | Promise<ContentBlock[]>): void {
  ctx.tools.register(defineContentToolFixture({
    name,
    description: name,
    parameters: {},
    async execute() {
      return await body()
    },
  }))
}

/** Dispatch one tool call through the real pipeline. */
function executeTool(ctx: Context, name: string, signal: AbortSignal, argumentsValue: Record<string, unknown> = {}): Promise<unknown> {
  return ctx.tools.execute({
    callId: CallId(nextCallId()),
    name,
    arguments: argumentsValue as unknown as JsonValue,
    signal,
  })
}

/** Let pending microtasks and a small macrotask settle. */
function tick(ms = 10): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Extract the structured error code of a bulkhead error result. */
function errorCode(result: unknown): string | undefined {
  const record = result as { error?: { info?: { code?: string } } }
  return record.error?.info?.code
}

/** A tool that blocks until released; records start order. */
function blockingTool(onStart: () => void, releases: Array<() => void>): () => Promise<ContentBlock[]> {
  return async () => {
    onStart()
    await new Promise<void>((resolve) => releases.push(resolve))
    return [{ type: 'text', text: 'ok' }]
  }
}

describe('concurrency cap', () => {
  it('runs calls concurrently up to maxConcurrent without queuing', async () => {
    const ctx = await harness({ rules: [{ tool: 'slow', maxConcurrent: 2 }] })
    const active: Array<string> = []
    const releases: Array<() => void> = []
    registerTool(ctx, 'slow', blockingTool((name = 'slow') => active.push(name), releases))
    const signal = new AbortController().signal

    const p1 = executeTool(ctx, 'slow', signal)
    await tick()
    const p2 = executeTool(ctx, 'slow', signal)
    await tick()
    expect(active).toHaveLength(2) // both started, neither queued
    releases.forEach((release) => release())
    await Promise.all([p1, p2])
    expect(active).toHaveLength(2)
  })

  it('caps concurrent execution exactly at maxConcurrent and queues the rest FIFO', async () => {
    const ctx = await harness({ rules: [{ tool: 'slow', maxConcurrent: 1, maxQueue: 10 }] })
    const started: string[] = []
    const releases: Array<() => void> = []
    registerTool(ctx, 'slow', blockingTool(() => started.push('slow'), releases))
    const signal = new AbortController().signal

    const p1 = executeTool(ctx, 'slow', signal)
    await tick()
    const p2 = executeTool(ctx, 'slow', signal)
    await tick()
    const p3 = executeTool(ctx, 'slow', signal)
    await tick()
    expect(started).toHaveLength(1) // only the first is executing

    releases[0]!()
    await tick()
    expect(started).toHaveLength(2) // FIFO head dequeued next
    releases[1]!()
    await tick()
    expect(started).toHaveLength(3)
    releases[2]!()
    await Promise.all([p1, p2, p3])
    expect(started).toHaveLength(3)
  })

  it('releases the slot after a failing call so the queue continues', async () => {
    const ctx = await harness({ rules: [{ tool: 'flaky', maxConcurrent: 1, maxQueue: 5 }] })
    let firstFailed = false
    const releases: Array<() => void> = []
    registerTool(ctx, 'flaky', async () => {
      if (!firstFailed) {
        firstFailed = true
        await new Promise<void>((resolve) => releases.push(resolve))
        throw new Error('boom')
      }
      return [{ type: 'text', text: 'ok' }]
    })
    const signal = new AbortController().signal

    const p1 = executeTool(ctx, 'flaky', signal)
    await tick()
    const p2 = executeTool(ctx, 'flaky', signal)
    await tick()
    releases[0]!()
    const [r1, r2] = await Promise.all([p1, p2])
    expect(errorCode(r1)).toBeUndefined() // thrown error materializes without info
    expect((r2 as { isError?: boolean }).isError).not.toBe(true)
    expect(firstFailed).toBe(true)
  })
})

describe('queue saturation', () => {
  it('times out a queued call past queueTimeout without executing it', async () => {
    const ctx = await harness({ rules: [{ tool: 'slow', maxConcurrent: 1, maxQueue: 5, queueTimeout: 40 }] })
    const started: string[] = []
    const releases: Array<() => void> = []
    registerTool(ctx, 'slow', blockingTool(() => started.push('slow'), releases))
    const signal = new AbortController().signal

    const p1 = executeTool(ctx, 'slow', signal)
    await tick()
    const p2 = executeTool(ctx, 'slow', signal)
    const r2 = await p2
    expect(errorCode(r2)).toBe('BULKHEAD_QUEUE_TIMEOUT')
    expect(started).toHaveLength(1) // the queued call never executed

    releases[0]!()
    await p1
    expect(started).toHaveLength(1)
  })

  it('rejects immediately when the queue is full and rejectWhenFull is set', async () => {
    const ctx = await harness({ rules: [{ tool: 'slow', maxConcurrent: 1, maxQueue: 1, rejectWhenFull: true }] })
    const started: string[] = []
    const releases: Array<() => void> = []
    registerTool(ctx, 'slow', blockingTool(() => started.push('slow'), releases))
    const signal = new AbortController().signal

    const p1 = executeTool(ctx, 'slow', signal)
    await tick()
    const p2 = executeTool(ctx, 'slow', signal)
    await tick()
    const p3 = executeTool(ctx, 'slow', signal)
    const r3 = await p3
    expect(errorCode(r3)).toBe('BULKHEAD_REJECTED')
    expect(started).toHaveLength(1)

    releases[0]!()
    await tick()
    releases[1]!() // unblock the dequeued p2
    await Promise.all([p1, p2])
    expect(started).toHaveLength(2)
  })

  it('keeps waiting past queue capacity when rejectWhenFull is not set', async () => {
    const ctx = await harness({ rules: [{ tool: 'slow', maxConcurrent: 1, maxQueue: 1 }] })
    const started: string[] = []
    const releases: Array<() => void> = []
    registerTool(ctx, 'slow', blockingTool(() => started.push('slow'), releases))
    const signal = new AbortController().signal

    const p1 = executeTool(ctx, 'slow', signal)
    await tick()
    const p2 = executeTool(ctx, 'slow', signal)
    await tick()
    const p3 = executeTool(ctx, 'slow', signal) // queue full, rejectWhenFull=false → still waits
    await tick()
    expect(started).toHaveLength(1)

    releases[0]!()
    await tick()
    releases[1]!()
    await tick()
    releases[2]!()
    await Promise.all([p1, p2, p3])
    expect(started).toHaveLength(3) // all eventually ran, none rejected
  })

  it('aborts a queued call cleanly without corrupting the queue', async () => {
    const ctx = await harness({ rules: [{ tool: 'slow', maxConcurrent: 1, maxQueue: 5 }] })
    const started: string[] = []
    const releases: Array<() => void> = []
    registerTool(ctx, 'slow', blockingTool(() => started.push('slow'), releases))
    const signal = new AbortController().signal
    const aborted = new AbortController()

    const p1 = executeTool(ctx, 'slow', signal)
    await tick()
    const p2 = executeTool(ctx, 'slow', aborted.signal)
    await tick()
    aborted.abort()
    const r2 = await p2
    expect(errorCode(r2)).toBe('BULKHEAD_ABORTED')
    expect(started).toHaveLength(1)

    const p3 = executeTool(ctx, 'slow', signal)
    await tick()
    releases[0]!()
    await tick()
    releases[1]!()
    await Promise.all([p1, p3])
    expect(started).toHaveLength(2) // p1 + p3 ran; the aborted p2 never executed
  })
})

describe('isolation', () => {
  it('keeps per-tool domains independent (tool A saturation does not block tool B)', async () => {
    const ctx = await harness({ rules: [
      { tool: 'tool_a', maxConcurrent: 1 },
      { tool: 'tool_b', maxConcurrent: 1 },
    ] })
    const started: string[] = []
    const releases: Array<() => void> = []
    registerTool(ctx, 'tool_a', blockingTool(() => started.push('tool_a'), releases))
    registerTool(ctx, 'tool_b', blockingTool(() => started.push('tool_b'), releases))
    const signal = new AbortController().signal

    const pA = executeTool(ctx, 'tool_a', signal)
    await tick()
    const pB = executeTool(ctx, 'tool_b', signal)
    await tick()
    expect(started).toEqual(['tool_a', 'tool_b']) // both started; separate domains

    releases[0]!()
    releases[1]!()
    await Promise.all([pA, pB])
  })

  it('shares a per-provider domain across grouped tools but leaves outsiders free', async () => {
    const ctx = await harness({ rules: [
      { domain: 'db', tools: ['db_a', 'db_b'], maxConcurrent: 1 },
    ] })
    const started: string[] = []
    const releases: Array<() => void> = []
    registerTool(ctx, 'db_a', blockingTool(() => started.push('db_a'), releases))
    registerTool(ctx, 'db_b', blockingTool(() => started.push('db_b'), releases))
    registerTool(ctx, 'other', async () => {
      started.push('other')
      return [{ type: 'text', text: 'ok' }]
    })
    const signal = new AbortController().signal

    const pA = executeTool(ctx, 'db_a', signal)
    await tick()
    const pB = executeTool(ctx, 'db_b', signal) // same domain → queued behind db_a
    await tick()
    const pOther = executeTool(ctx, 'other', signal) // no rule → passes through
    await tick()
    expect(started).toContain('other')
    expect(started).toEqual(['db_a', 'other']) // db_b queued, not started

    releases[0]!()
    await tick()
    releases[1]!() // unblock the dequeued db_b
    await Promise.all([pA, pB, pOther])
    expect(started).toEqual(['db_a', 'other', 'db_b'])
  })
})

describe('defaults and pass-through', () => {
  it('inherits defaults for fields a rule omits and overrides with explicit ones', async () => {
    const ctx = await harness({
      defaults: { maxConcurrent: 1, queueTimeout: 40 },
      rules: [{ tool: 'inherited' }, { tool: 'override', maxConcurrent: 2 }],
    })
    const started: string[] = []
    const releases: Array<() => void> = []
    registerTool(ctx, 'inherited', blockingTool(() => started.push('inherited'), releases))
    registerTool(ctx, 'override', blockingTool(() => started.push('override'), releases))
    const signal = new AbortController().signal

    const p1 = executeTool(ctx, 'inherited', signal)
    await tick()
    const p2 = executeTool(ctx, 'inherited', signal)
    const r2 = await p2
    expect(errorCode(r2)).toBe('BULKHEAD_QUEUE_TIMEOUT') // inherited maxConcurrent 1 + queueTimeout 40

    const pA = executeTool(ctx, 'override', signal)
    const pB = executeTool(ctx, 'override', signal)
    await tick()
    expect(started).toEqual(['inherited', 'override', 'override']) // maxConcurrent 2 → both start

    releases.forEach((release) => release())
    await Promise.all([p1, pA, pB])
  })

  it('passes through tools without a matching rule', async () => {
    let attempts = 0
    const ctx = await harness({ rules: [{ tool: 'matched', maxConcurrent: 1 }] })
    registerTool(ctx, 'other', async () => {
      attempts += 1
      return [{ type: 'text', text: 'ok' }]
    })
    const signal = new AbortController().signal
    await executeTool(ctx, 'other', signal)
    await executeTool(ctx, 'other', signal)
    expect(attempts).toBe(2)
  })

  it('stays inert with an empty rules list', async () => {
    let attempts = 0
    const ctx = await harness({})
    registerTool(ctx, 'anything', async () => {
      attempts += 1
      return [{ type: 'text', text: 'ok' }]
    })
    const signal = new AbortController().signal
    await executeTool(ctx, 'anything', signal)
    expect(attempts).toBe(1)
  })
})

describe('fail-loud config validation', () => {
  it('rejects a tool rule that also declares a domain', async () => {
    await expect(harness({ rules: [{ tool: 'x', domain: 'y' }] })).rejects.toThrow(/exactly one of `tool` or `domain`/)
  })

  it('rejects a domain rule with an empty tools list', async () => {
    await expect(harness({ rules: [{ domain: 'g', tools: [] }] })).rejects.toThrow(/non-empty `tools` list/)
  })

  it('rejects non-positive concurrency and queue limits', async () => {
    await expect(harness({ rules: [{ tool: 'x', maxConcurrent: 0 }] })).rejects.toThrow(/maxConcurrent/)
    await expect(harness({ rules: [{ tool: 'x', maxQueue: 0 }] })).rejects.toThrow(/maxQueue/)
    await expect(harness({ rules: [{ tool: 'x', queueTimeout: -1 }] })).rejects.toThrow(/queueTimeout/)
  })

  it('rejects invalid defaults', async () => {
    await expect(harness({ defaults: { maxConcurrent: 0 } })).rejects.toThrow(/defaults maxConcurrent/)
  })
})

describe('metric events', () => {
  it('emits queued / acquired / released / rejected / timed-out', async () => {
    const ctx = await harness({ rules: [{ tool: 'slow', maxConcurrent: 1, maxQueue: 2, queueTimeout: 40, rejectWhenFull: true }] })
    const seen: BulkheadEvent[] = []
    const domainLog: Array<{ event: BulkheadEvent; domain?: string }> = []
    for (const event of ['bulkhead/queued', 'bulkhead/acquired', 'bulkhead/released', 'bulkhead/rejected', 'bulkhead/timed-out'] as const) {
      ctx.on(event, (data: { domain?: string }) => {
        seen.push(event)
        domainLog.push({ event, domain: data.domain })
      })
    }
    const started: string[] = []
    const releases: Array<() => void> = []
    registerTool(ctx, 'slow', blockingTool(() => started.push('slow'), releases))
    const signal = new AbortController().signal

    const p1 = executeTool(ctx, 'slow', signal) // acquired
    await tick()
    const p2 = executeTool(ctx, 'slow', signal) // queued (depth 1) → timed out
    await tick()
    const p3 = executeTool(ctx, 'slow', signal) // queued (depth 2) → timed out
    await tick()
    const p4 = executeTool(ctx, 'slow', signal) // queue full → rejected
    const r4 = await p4
    expect(errorCode(r4)).toBe('BULKHEAD_REJECTED')
    expect(errorCode(await p2)).toBe('BULKHEAD_QUEUE_TIMEOUT')
    expect(errorCode(await p3)).toBe('BULKHEAD_QUEUE_TIMEOUT')
    releases[0]!() // unblock p1
    await p1

    expect(seen).toContain('bulkhead/acquired')
    expect(seen).toContain('bulkhead/queued')
    expect(seen).toContain('bulkhead/rejected')
    expect(seen).toContain('bulkhead/timed-out')
    expect(seen).toContain('bulkhead/released')
    expect(domainLog.every((entry) => entry.domain === 'tool:slow')).toBe(true)
  })
})
