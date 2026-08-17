# dsh-tool-bulkhead

[English](README.en.md) | 中文

> DeepSeek Harness 的 Agent 工具并发隔离 / 背压插件：per-tool 与 per-provider 隔离域，FIFO 排队、排队超时、队列满拒绝——在压力扩散成故障之前限住 blast radius。

## 解决什么问题

多个 Agent 并发调用共享工具时，慢调用堆积打满下游连接池：

```text
Agent A ─┐
Agent B ─┤──→ database_query ──→ 连接池打满 ──→ 全部 timeout
Agent C ─┘
```

Rate limit 防「每秒 N 次」；Bulkhead 防「同一时刻最多 N 个正在执行」——即使 QPS 不高，30 秒一次的慢请求也能让 100 个调用同时挂着。

## 使用

```yaml
bulkhead:
  defaults: { maxConcurrent: 8, maxQueue: 50, queueTimeout: 30000, rejectWhenFull: false }
  rules:
    - tool: 'database_*'          # per-tool：每个匹配工具名独立 domain
      maxConcurrent: 2
      maxQueue: 10
      queueTimeout: 5000
    - domain: 'llm-shared'        # per-provider：一组工具共享一个 domain
      tools: ['chat_*', 'embedding_*']
      maxConcurrent: 4
      rejectWhenFull: true
```

行为：超并发排队（FIFO）→ 超时 `BULKHEAD_QUEUE_TIMEOUT` / 队列满拒绝 `BULKHEAD_REJECTED` / 排队中止 `BULKHEAD_ABORTED`；无规则匹配零影响透传。

## 生态位置

官方 `dsh-tool-call-timeout-policy` 管单调用超时，本插件管并发容量——正交可组合。与 `dsh-chaos` / `dsh-tool-idempotency` / `dsh-tool-transaction` 组成 DSH Reliability Suite：

```text
bulkhead（压力扩散前：限住并发）→ chaos（制造故障）→ idempotency（安全 retry）→ transaction（补偿）
```

## 状态

🚧 MVP 开发中（2026-08-17）：设计规格定稿，骨架就绪，核心实现与单元测试进行中。发布后将更新此节。

- 设计：ARCHITECTURE.md
- 仓库：https://github.com/WHY-Daydream/dsh-tool-bulkhead
- 系列：`dsh-chaos` · `dsh-tool-transaction` · `dsh-tool-idempotency`
