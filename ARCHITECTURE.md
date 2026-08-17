# dsh-tool-bulkhead 架构设计

> 状态：设计定稿（2026-08-17）。本文档是实现的规格说明，对应开发顺序 ①–⑥。

## ① 问题边界

**要解决的**：多个 Agent 并发调用共享工具时，慢调用堆积打满下游连接池，把压力扩散成全部 timeout。

```text
Agent A ─┐
Agent B ─┤
Agent C ─┤──→ database_query ──→ 连接池打满 ──→ 全部 timeout
Agent D ─┤
Agent E ─┘
```

- Rate limit 防的是「每秒 N 次」；**Bulkhead 防的是「同一时刻最多 N 个正在执行」**——即使 QPS 不高，30 秒一次的慢请求也能让 100 个调用同时挂着
- 官方 `dsh-tool-call-timeout-policy` 管的是「单调用超时」（deadline），本插件管的是「并发隔离」（容量）——正交可组合：排队中的调用同样受全局 timeout 约束
- 社区已有现实信号：DSH 官方讨论 #1262 报告 FrameQueue 缺 backpressure/high-watermark 导致 100% CPU busy loop——「背压与资源隔离」是 Harness 可靠性里的真实空白

**边界声明（不做的事）**：

- 不做跨进程/分布式限流——单进程内隔离，多实例场景由部署层（连接池、网关）兜底
- 不做速率限流（QPS/窗口）——那是 rate-limit 插件领域，与并发隔离互补
- 不做自适应动态调整（P95 反馈调参）——v1.1 候选
- 只对**显式配置**的工具生效；无规则匹配时零影响（与 dsh-chaos / dsh-tool-idempotency 同约定）
- 排队语义是 best-effort 的进程内等待；进程崩溃后队列丢失（与套件既有边界一致）

## ② 并发隔离模型

四个核心概念 + 两种隔离粒度：

| 概念 | 定义 |
|---|---|
| **domain（隔离域）** | 一个独立的容量调度单元：`inFlight`（执行中计数）+ `queue`（FIFO 等待队列）+ 各自限额 |
| **maxConcurrent** | 同一 domain 同时执行中的最大调用数（信号量容量） |
| **maxQueue** | 超出并发时允许排队的最大调用数 |
| **queueTimeout** | 排队最长等待（毫秒），超时返回 `BULKHEAD_QUEUE_TIMEOUT`；`undefined` = 无限等待 |
| **rejectWhenFull** | 队列满时的策略：`true` 立即拒绝（`BULKHEAD_REJECTED`）；`false` 继续等待（仍受 queueTimeout 约束） |

两种隔离粒度：

| 粒度 | 配置形态 | 语义 |
|---|---|---|
| **per-tool** | `tool: 'database_*'` | 每个匹配到的工具名各自一个 domain（互不挤占） |
| **per-provider** | `domain: 'db-primary'` + `tools: ['database_query', 'database_write']` | 一组工具共享一个 domain（模拟共享连接池/提供商资源） |

**配置（schemastery，fail-loud 校验）**：

```yaml
bulkhead:
  defaults:                       # 可选：未在规则中指定的限额回退值
    maxConcurrent: 8
    maxQueue: 50
    queueTimeout: 30000           # 毫秒；省略 = 无限等待
    rejectWhenFull: false
  rules:                          # 首条匹配生效
    - tool: 'database_*'          # per-tool：每个匹配工具名独立 domain
      maxConcurrent: 2
      maxQueue: 10
      queueTimeout: 5000
    - tool: 'web_search'
      maxConcurrent: 5
    - domain: 'llm-shared'        # per-provider：一组工具共享一个 domain
      tools: ['chat_*', 'embedding_*']
      maxConcurrent: 4
      rejectWhenFull: true
```

- 规则字段：`tool`（通配模式）**或** `domain` + `tools`（模式数组），两者互斥，同时出现 fail-loud
- 限额字段（`maxConcurrent` / `maxQueue` / `queueTimeout` / `rejectWhenFull`）均可省略，继承 `defaults`；`defaults` 未配置则用内置默认（8 / 50 / 无限 / false）
- `maxConcurrent` / `maxQueue` 必须为正整数；`queueTimeout` 为非负整数——非法即加载抛错

**结构化错误码**（复用套件错误码约定，`error.info.name` 带 `Bulkhead*` 类别）：

| 码 | 含义 |
|---|---|
| `BULKHEAD_REJECTED` | 队列满且 `rejectWhenFull: true` → 立即拒绝，不执行 |
| `BULKHEAD_QUEUE_TIMEOUT` | 排队超过 `queueTimeout` → 放弃，不执行 |
| `BULKHEAD_ABORTED` | 排队期间 `exec.signal` 中止 → 出队，不执行 |

## ③ 调度状态机（每个 domain）

```text
调用到达
  ├─ inFlight < maxConcurrent ──▶ 立即执行（inFlight+1）
  │
  ├─ inFlight = maxConcurrent 且 queue < maxQueue
  │   └─▶ 入队（FIFO）── 等待 release / queueTimeout / abort
  │
  └─ inFlight = maxConcurrent 且 queue = maxQueue
      ├─ rejectWhenFull=true ──▶ BULKHEAD_REJECTED
      └─ rejectWhenFull=false ──▶ 继续等待（queueTimeout 仍生效）
```

执行完成（成功或失败均）→ `inFlight-1` → 唤醒队列头部，FIFO 出队执行。

**关键语义**：

- **FIFO 公平**：队列是严格先到先执行，不做优先级
- **超时/中止不占槽**：排队中的调用超时或中止后立刻出队，不影响队列顺序
- **失败也释放**：无论工具成功/失败/抛错，槽位都在调用结束时释放（没有「失败占用」死锁）
- **复用 chaos 的 `delay(ms, signal)` 惯用法**：等待期间监听 abort，不挂住被取消的 turn

## ④ DSH Tool Pipeline 接入

拦截点：`tools/execute` around-dispatch 包装器（与 dsh-chaos / dsh-tool-idempotency 同级）。

```text
tool/call → tools/pre-execute → guards → tools/execute ★主拦截点 → tools/post-execute → tools/result
```

- 包装器语义：查规则 → 解析 domain → 调度（执行/入队/拒绝）→ 获得槽位后 `next()` → 完成后释放槽位并唤醒队列
- `exec.name`（工具名匹配）/ `exec.signal`（abort 感知）/ `exec.agent` 为 `undefined` 的直接 `ctx.tools.execute()` 调用方同样生效（与 idempotency 同约定）
- **组合顺序（注册顺序 = 包裹顺序）**：

```text
dsh-tool-bulkhead（最外层：先限并发）
  → dsh-chaos（注入延迟/超时/429）
    → dsh-tool-idempotency（同 key 去重/复用）
      → dsh-tool-transaction（Saga 补偿）
```

Bulkhead 必须**最先注册**：chaos 注入的 latency/timeout 调用仍占据下游资源，应计入并发槽位——只有包在最外层才能正确度量「整个下游链路的真实并发」。

**metrics**（观测性，MVP 为事件钩子，不引入外部 metrics 依赖）：

| 事件 | 载荷要点 |
|---|---|
| `bulkhead/queued` | domain / tool / queueDepth |
| `bulkhead/acquired` | domain / tool / inFlight |
| `bulkhead/released` | domain / tool / inFlight（释放后） |
| `bulkhead/rejected` | domain / tool / reason（full） |
| `bulkhead/timed-out` | domain / tool / queueTimeout |

## ⑤ 实现要点

```ts
interface DomainState {
  inFlight: number
  queue: Waiter[]   // FIFO：{ exec, resolve, reject, timer, aborted }
  limits: { maxConcurrent, maxQueue, queueTimeout, rejectWhenFull }
}

interface Waiter {
  exec: ToolExecution
  resolve: (r: ToolExecutionResult) => void
  reject: (e: unknown) => void
  timer?: NodeJS.Timeout      // queueTimeout 定时器
  onAbort: () => void         // signal 监听
}
```

- 信号量不引入依赖：`inFlight` 计数 + 手动 resolve 的 promise 队列即可，零依赖
- 规则编译：`tool` 通配 → 锚定 RegExp（复用 idempotency 的 `wildcardToRegExp` 惯用法）；`domain+tools` → 数组任一模式匹配
- 首条匹配生效：规则按配置顺序编译，逐条 test，命中即用该 domain 限额；domain key = `rule-key@tool` 或 `group@domain名`
- 同一 domain 的并发修改全部发生在微任务边界内（acquire 同步执行、release 异步），无竞态
- fail-loud：非法规则（`tool` 与 `domain` 同时声明、空 `tools`、非法数值、空 rules 数组可但视为空转）→ 加载即抛错

## ⑥ 危险场景清单（= 单元测试矩阵）

| # | 场景 | 期望行为 |
|---|---|---|
| 1 | 并发未超限 | 全部立即执行，inFlight 不越界 |
| 2 | 并发恰好 = maxConcurrent | 全部执行，无排队无拒绝 |
| 3 | 超限排队 | FIFO：先到先执行，全部成功 |
| 4 | 排队超时 | `BULKHEAD_QUEUE_TIMEOUT` 错误结果，工具不执行，槽位不泄漏 |
| 5 | 队列满 + rejectWhenFull=true | `BULKHEAD_REJECTED`，工具不执行 |
| 6 | 队列满 + rejectWhenFull=false | 继续等待（受 queueTimeout 约束） |
| 7 | per-tool 隔离 | tool A 饱和不影响 tool B |
| 8 | per-provider 隔离 | 共享 domain 内工具互相计数，外部工具不受影响 |
| 9 | defaults 继承与覆盖 | 未声明字段继承 defaults，声明字段覆盖 |
| 10 | 无规则匹配 | 零影响透传（插件空转） |
| 11 | 排队期间 abort | 出队且不执行，不挂住 |
| 12 | 失败/抛错后释放 | 槽位正常释放，后续队列继续 |
| 13 | fail-loud 配置校验 | 非法规则/数值 → 加载即抛错 |
| 14 | metrics 事件 | queued/acquired/released/rejected/timed-out 按需发出 |

## 与套件的关系（Reliability Suite 完整链路）

```text
dsh-tool-bulkhead（压力扩散前：限住并发 blast radius）
  → Tool Runtime
    → dsh-chaos（制造 timeout/429）
      → dsh-tool-idempotency（安全 retry）
        → dsh-tool-transaction（副作用补偿）
          → Recovery
```

前三款解决「故障发生之后」，bulkhead 解决「故障扩散之前」——系列补上最后一块拼图。

## 里程碑

1. ✅ 命名统一 + 生态扫描（2026-08-17：GitHub 0 同名；npm 名可用；官方无 bulkhead/backpressure 竞品，`timeout-policy` 正交）
2. ✅ 架构设计（本文档）
3. ⏳ 包骨架（package.json / tsconfig / vitest / cordis.patch.yml）
4. ⏳ 核心实现（Config + apply + domain 调度器）
5. ⏳ 单元测试（上表 14 项矩阵）
6. ⏳ 验证全绿（vitest / oxlint / tsc）
7. ⏳ E2E 与发布（后续阶段，对齐套件节奏）
