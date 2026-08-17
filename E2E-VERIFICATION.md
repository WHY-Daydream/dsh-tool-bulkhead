# dsh-tool-bulkhead E2E 验证记录（真实 Profile 场景）

> 状态：全部可达场景已完成（截至 2026-08-17）。本文记录在**真实 DSH profile + 真实 Agent loop** 下对 `@why-daydream/dsh-tool-bulkhead` 的端到端验证结果、方法与复现要点。

## 一、背景与目标

插件已通过代码级验证（17/17 单测、`tsc`、`oxlint`），本阶段目标：在真实 Harness 环境证明 bulkhead 确实按预期**限流、排队、释放槽位**——而不是只在 mock 里工作。

验证链路（Reliability Suite 组合）：

```text
dsh-tool-bulkhead（限制并发 / blast radius）
  → dsh-chaos（制造 latency / timeout / 429）
    → dsh-tool-idempotency（安全 retry）
      → dsh-tool-transaction（副作用补偿）
```

## 二、环境与方法

| 项 | 值 |
|---|---|
| DSH 运行来源 | 本地 checkout（`/mnt/workspace/DSH/deepseek-harness`），`node --import tsx/esm apps/cli/src/bin.ts` |
| 插件 | `@why-daydream/dsh-tool-bulkhead`（`/mnt/workspace/DSH/dsh-tool-bulkhead`，独立仓库） |
| Profile | `bulkhead-e2e`（`/root/.dsh/profiles/bulkhead-e2e`） |
| Profile bundles | `@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-headless` + `@why-daydream/dsh-tool-bulkhead` + `@why-daydream/test-slow-tool` + `@why-daydream/dsh-chaos` |
| LLM 供应 | 独立 mock（`/tmp/bulkhead-mock.mjs`，OpenAI 兼容 SSE）：**首个请求单响应发 N 个 `slow_work` tool-call 块**，后续请求回 success 文本 |
| 测试工具 | `@why-daydream/test-slow-tool`（独立 E2E 工具插件，`/mnt/workspace/DSH/bulkhead-test-tool`）：`slow_work`（默认延迟 400ms、abort-aware）、`fail_work`（抛错） |
| 规则注入 | `dsh --profile bulkhead-e2e --patch <patch.yml> "task"`，patch 按 id 替换 `tool-bulkhead` / `chaos` 行 config |
| 结果核验 | 解压 session 日志（`/root/.dsh/sessions/--mnt-workspace-DSH-deepseek-harness--/<id>/session.jsonl.zstd`）中的 `tool/call` / `tool/result` 事件与时间戳 |

**关键设计**：`tool/call` 事件是 loop **分发**时刻（并发池一次打点），不是实际执行时刻——峰值并发用**完成波形**核验（每 `执行时长` 一波完成几个 = 峰值并发），时长 = 排队等待 + 执行。

## 三、已完成的场景与结果

### 3.1 安装与加载（已完成 ✅）

```sh
dsh plugin --profile bulkhead-e2e add link:/mnt/workspace/DSH/dsh-tool-bulkhead
dsh plugin --profile bulkhead-e2e add link:/mnt/workspace/DSH/bulkhead-test-tool
dsh plugin --profile bulkhead-e2e add link:/mnt/workspace/DSH/dsh-chaos
```

- `dsh.profile.bundles` 调和后包含 `@why-daydream/dsh-tool-bulkhead` / `test-slow-tool` / `dsh-chaos`
- `dsh --profile bulkhead-e2e --dump-config` 输出末尾出现：

```yaml
# == @why-daydream/dsh-tool-bulkhead
- id: tool-bulkhead
  name: '@why-daydream/dsh-tool-bulkhead'
# == @why-daydream/dsh-chaos
- id: chaos
```

✅ **插件树加载成功（bulkhead + chaos + 测试工具三层）。**

### 3.2 并发上限 maxConcurrent=2（5 并发 + FIFO）✅

- 规则：`slow_work: { maxConcurrent: 2, maxQueue: 10 }`；mock 首响应发 5 个 tool-call
- session 日志（`tool/call` 全在分发时刻打点，`tool/result` 按完成时刻）：

| 调用 | 分发 | 完成 | duration | 排队等待 |
|---|---|---|---|---|
| mock-call-1 | t0 | t0+411ms | 411ms | ≈0 |
| mock-call-2 | t0 | t0+412ms | 412ms | ≈0 |
| mock-call-3 | t0 | t0+810ms | 810ms | ≈410ms |
| mock-call-4 | t0 | t0+813ms | 813ms | ≈413ms |
| mock-call-5 | t0 | t0+1209ms | 1209ms | ≈809ms |

- **完成波形**：每 400ms 一波，波次归属 `[0,0,1,1,2]` → 每波完成数 `{0:2, 1:2, 2:1}` → **峰值并发 = 2** ✅
- **FIFO 完成顺序**：`mock-call-1 → 2 → 3 → 4 → 5` ✅（严格先到先执行）

### 3.3 queueTimeout（排队超时返回明确错误）✅

- 规则：`slow_work: { maxConcurrent: 1, maxQueue: 10, queueTimeout: 150 }`
- session 日志 `tool/result` 实测：

```json
mock-call-1: isError=false（正常执行）
mock-call-2..5: isError=true  error={name: 'BulkheadQueueTimeout', code: 'BULKHEAD_QUEUE_TIMEOUT'}
  content: "Error: bulkhead call waited 150ms in domain `tool:slow_work` without a free slot — timing out"
```

✅ **排队超时以真实结构化错误码到达 Agent，工具不执行。**

### 3.4 rejectWhenFull（队列满立即拒绝）✅

- 规则：`slow_work: { maxConcurrent: 1, maxQueue: 1, rejectWhenFull: true }`
- session 日志实测：

```json
mock-call-1,2: isError=false（1 执行 + 1 排队）
mock-call-3..5: isError=true  error={name: 'BulkheadRejected', code: 'BULKHEAD_REJECTED'}
  content: "Error: bulkhead domain `tool:slow_work` is full (1 executing, 1 queued) — refusing the call"
```

✅ **第 3 个起立即拒绝，前 2 个正常完成。**

### 3.5 工具失败后槽位释放 ✅

- 规则：`fail_work: { maxConcurrent: 1, maxQueue: 5 }`；mock 发 2 个 `fail_work` 调用
- session 日志实测：`mock-call-1` 与 `mock-call-2` **都执行了**（`Error: fail_work injected failure id=1/2`）

✅ **首个调用抛错后槽位正常释放，排队的后续调用继续执行——无卡死、无槽位泄漏。**

### 3.6 abort（排队请求取消）⚠️ 单测覆盖 + CLI 限制记录

- 尝试：SIGINT（exit 130）×2 / SIGTERM（exit 0）×2，测试工具 abort-aware（信号触发立即 reject）
- 现象：4 次中断后 session 均止于 `tool/call`（5 个）、**0 个 `tool/result`**——headless CLI 的**信号关停路径不把排队中/执行中的调用结果落盘**（即使进程 2 秒内优雅退出、exit=0）
- 结论：abort 语义**已由单元测试覆盖**（17/17 含 "aborts a queued call cleanly without corrupting the queue"——真实工具管线 + 真实 AbortController）；真实 profile 下 SIGINT/SIGTERM 观测受 CLI 持久化限制，无法从 session 日志闭环，属**环境限制而非插件缺陷**（插件返回 `BULKHEAD_ABORTED` 的逻辑与单测一致）

### 3.7 dsh-chaos + bulkhead 组合（10 并发 + latency 注入）✅ 最高价值

- 规则：

```yaml
- id: tool-bulkhead
  config:
    rules: [{ tool: slow_work, maxConcurrent: 2, maxQueue: 10 }]
- id: chaos
  config:
    rules: [{ tool: slow_work, latency: { min: 2000, max: 2000 } }]
```

- mock 首响应发 **10 个** tool-call；chaos 给每次执行注入 2000ms latency；bulkhead 限并发 2
- session 日志实测（duration = 排队 + 2000ms 执行）：

| 调用 | duration | 排队等待 |
|---|---|---|
| 1, 2 | 2404 / 2403ms | ≈400ms（含 chaos 注入余量） |
| 3, 4 | 4802 / 4802ms | ≈2800ms |
| 5, 6 | 7202 / 7203ms | ≈5200ms |
| 7, 8 | 9602 / 9602ms | ≈7600ms |
| 9, 10 | 12002 / 12003ms | ≈10000ms |

- **完成波形**：5 波 × 每波恰好 2 个，波次归属 `[0,0,1,1,2,2,3,3,4,4]` → **峰值并发 = 2** ✅
- **FIFO 顺序**：`mock-call-1 → … → mock-call-10` 严格有序 ✅
- 总耗时 ≈ 12s = 10 调用 ÷ 2 并发 × 2000ms（chaos latency 下 bulkhead 仍精确限住 blast radius）✅

✅ **证明 bulkhead 在真实 chaos 故障注入下确实限制峰值并发，而不是只在 mock 里工作。**

## 四、复现脚本与要点

场景 patch 与 mock 均在 `/tmp/`：`bulkhead-*.patch.yml`、`bulkhead-mock.mjs`（`PORT` / `TOOL_CALLS` / `TOOL_NAME` / `TOOL_DELAY_MS` 环境变量）。标准流程：

```sh
# 1. 重启 mock（重置行为序列——首个请求才发 N 个 tool-call；`--repeat-last` 语义同理）
TOOL_CALLS=10 setsid node /tmp/bulkhead-mock.mjs > /tmp/bulkhead-mock.log 2>&1 < /dev/null &
# 2. 跑 headless 任务
DEEPSEEK_BASE_URL=http://127.0.0.1:8000/v1 DEEPSEEK_API_KEY=mock-key \
  node --import tsx/esm apps/cli/src/bin.ts --profile bulkhead-e2e \
  --patch /tmp/bulkhead-<scenario>.patch.yml "please run the work"
# 3. 核验 session 日志（zstd 压缩 JSONL）
SES=$(ls -t /root/.dsh/sessions/--mnt-workspace-DSH-deepseek-harness--/ | head -1)
unzstd -c "$SESDIR/$SES/session.jsonl.zstd" | grep '"type":"tool/result"'
```

## 五、过程中发现的问题与修复（重要经验）

1. **`pnpm` 不可用**：corepack shim 需从 registry 下载 pnpm 本体（npmjs 不可达，`ConnectTimeout`）。改用 `npm install -g pnpm@9 --registry=https://registry.npmmirror.com --force` 覆盖 shim。
2. **profile 内 pnpm install 连不上 npmjs**：在 profile 目录写 `.npmrc`（`registry=https://registry.npmmirror.com` + `ignore-workspace-root-check=true`）。pnpm 9 对 workspace root 加依赖有 `ERR_PNPM_ADDING_TO_ROOT` 守卫，需后者。
3. **`dsh plugin add` 的 `link:` 协议**：本地插件必须用 `link:`（`file:` 会因 workspace 依赖解析失败）；profile 的 `dsh.profile.bundles` 手工补 `@deepseek-ai/dsh-headless`（in-box bundle，`plugin add` 会误装为普通依赖且路径错误）。
4. **测试工具必须声明 `isConcurrencySafe: () => true`**：否则 agent loop 按 exclusive barrier **串行分发**（5 个调用严格 1 个 1 个跑，bulkhead 见不到并发）——`tools/execute` 的 `executionMode` 对非并发安全工具返回 `exclusive`。
5. **观测方法**：`tool/call` 是分发时刻打点（并发池一次全打），峰值并发按**完成波形**（每执行时长完成几个）而非 start 采样——start 采样会误报为 5。
6. **信号中断不落盘**：SIGINT/SIGTERM 后 session 止于 `tool/call`、无 `tool/result`——headless CLI 的信号关停不持久化排队中调用的结果；abort 场景由单测覆盖。
7. **`pkill -f <脚本名>` 会杀到自己**：命令行含匹配模式时 pkill 命中 bash 自身（`[process terminated by signal]`）。改用按端口 PID：`ss -tlnp | grep ':8000' | grep -oP 'pid=\K[0-9]+'`。
8. **session 目录复用**：headless 按命令哈希复用 session 目录（多次运行 `ls -t | head -1` 可能取到旧 session），核验前确认 mtime 或清理旧目录。
9. **mock 行为序列重置**：mock 首个请求才发 tool-call，跑完一次后需重启 mock，否则后续任务模型只收到 success 文本、无工具调用。

## 六、相关文件

| 路径 | 说明 |
|---|---|
| `/mnt/workspace/DSH/dsh-tool-bulkhead/` | 独立插件仓库（src/tests/package.json/tsconfig/cordis.patch.yml/README/LICENSE） |
| `/mnt/workspace/DSH/bulkhead-test-tool/` | E2E 测试工具插件（`slow_work` abort-aware / `fail_work`），不发布 |
| `/root/.dsh/profiles/bulkhead-e2e/` | E2E profile（package.json + cordis.patch.yml + pnpm-workspace.yaml + .npmrc） |
| `/tmp/bulkhead-mock.mjs` | 独立多 tool-call mock（OpenAI 兼容 SSE） |
| `/tmp/bulkhead-<scenario>.patch.yml` | 各场景规则 patch（concurrency / queuetimeout / reject / failure / abort / chaos-combo） |
| `/root/.dsh/sessions/--mnt-workspace-DSH-deepseek-harness--/<id>/session.jsonl.zstd` | session 日志（zstd JSONL，含 `tool/call`/`tool/result`/`turn/*`） |
