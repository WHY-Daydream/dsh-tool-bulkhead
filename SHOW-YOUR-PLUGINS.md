# [Show & Tell] dsh-tool-bulkhead — Concurrency isolation and backpressure for DeepSeek Harness

> Draft for the DeepSeek Harness community Show & Tell. Posting happens after
> the v0.1.0 release chain completes; this file is the source copy.

## The problem

A slow downstream tool does **not** need high QPS to exhaust Agent runtime
resources.

```text
100 requests × 30s latency
= 100 concurrent in-flight calls
= exhausted connection pool
= every agent's tool call times out
```

Rate limiting counts calls per second; a **bulkhead** caps how many calls may
be **in flight at the same time** — the pressure limiter that stops a slow
downstream from turning into an outage for everyone.

## What it does

```text
Tool calls
   ↓
dsh-tool-bulkhead
   ├── maxConcurrent      (in-flight cap per domain)
   ├── FIFO queue         (excess calls wait in order)
   ├── queueTimeout       (wait cap → BULKHEAD_QUEUE_TIMEOUT)
   ├── rejectWhenFull     (queue full → BULKHEAD_REJECTED)
   └── per-tool / per-provider isolation (independent domains)
   ↓
Downstream Tool
```

- Per-tool domains (`database_*`) and per-provider shared domains
  (`db-primary` = `database_query` + `database_write`) with independent limits
- Structured error codes: `BULKHEAD_REJECTED` / `BULKHEAD_QUEUE_TIMEOUT` /
  `BULKHEAD_ABORTED`
- Abort-aware queuing (a cancelled call leaves the queue without wedging it)
- Slot release after failure (a throwing tool does not deadlock the queue)
- Metric events: `bulkhead/queued · acquired · released · rejected · timed-out`

## Verified in a real DSH agent loop (no mock-only claims)

`dsh-chaos` injecting 2000ms latency into every call, 10 concurrent calls,
bulkhead `maxConcurrent = 2`:

```text
10 concurrent calls
        ↓
bulkhead maxConcurrent=2
        ↓
dsh-chaos latency=2000ms
        ↓
5 completion waves, exactly 2 per wave
        ↓
peak concurrency = 2
FIFO = 1 → 10
```

Also verified end-to-end: concurrency cap, FIFO order, queue timeout,
reject-on-full, slot release after failure, per-tool/per-provider isolation,
out-of-tree clean install, and the packed-tarball smoke test.

## Position in the WHY-Daydream Reliability Suite

```text
dsh-tool-bulkhead      (limit pressure BEFORE it spreads)
  → dsh-chaos          (inject faults)
    → dsh-tool-idempotency  (safe retry)
      → dsh-tool-transaction (Saga compensation)
```

- npm: `@why-daydream/dsh-tool-bulkhead` (v0.1.0)
- GitHub: https://github.com/WHY-Daydream/dsh-tool-bulkhead
- MIT License
