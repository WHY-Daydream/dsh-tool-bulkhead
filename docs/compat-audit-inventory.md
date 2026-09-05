# dsh-tool-bulkhead — Latest-DSH Compatibility Audit（audit-only）

**Date**: 2026-09-05
**Branch**: `audit/latest-dsh-compat`（基线 main = `4de80b8`，published v0.1.0）
**方法**: 完全复用 dsh-chaos 的 PCA-01~10 模板（audit-first，不改 production、不发布）。
**铁律**: 能安装 ≠ 能注册 ≠ 并发隔离语义没变；PCA-09（runtime golden）优先于 peer range。

## 开发基线（devDeps link → 本地 deepseek-harness 工作树）

| package | link 版本 |
|---|---|
| @deepseek-ai/cordis | 4.0.1 |
| @deepseek-ai/dsh-invariants | 0.1.0-rc.5 |
| @deepseek-ai/dsh-llm | 0.1.0-rc.5（仅 tests 用） |
| @deepseek-ai/dsh-system-prompt | 0.1.0-rc.5（仅 tests 用） |
| @deepseek-ai/dsh-tools | 0.1.0-rc.5 |

npm 已发布 peer floors（v0.1.0）：cordis `>=4.0.1`、dsh-invariants `>=0.0.1-rc.1`、
dsh-tools `>=0.0.1-rc.1` → 裸 prerelease 地板（tuple (0,0,1)），疑似与 chaos 同款
0.1.x 匹配问题（PCA-01 复现）。
注：`scripts/prepare-release.mjs` 把 devDeps 钉在 0.0.1-rc.1（发布期 fixtures），
与 peer 地板一致——若 peer union 放开，该脚本的 fixture 钉法也需评估（release 面）。

## Consumer-symbol 清单（production：src/）

### src/index.ts — apply(ctx, config) 主插件
| package | symbol | kind | 使用方式 |
|---|---|---|---|
| @deepseek-ai/cordis | `Context` / `Events` | type | apply(ctx) 参数；`declare module '@deepseek-ai/cordis' { interface Events { 'bulkhead/*' } }` 指标事件面 |
| @deepseek-ai/dsh-tools | `ToolExecution` | type | exec.name / exec.signal（调度判定、abort 监听） |
| @deepseek-ai/dsh-tools | `ToolExecutionResult` | type | 结构化错误 `{isError, content, error:{message, info:{name, code}}}`（同 chaos 形状） |
| @deepseek-ai/schemastery | `z`（default） | value | `Config: z<Config>` schema（依赖面，非 peer） |

**消费的 Cordis 契约**：
- `ctx.on('tools/execute', (exec, next) => Promise<ToolExecutionResult>)` — 唯一拦截缝；
  `next()` 委托真实执行；超限时排队/拒绝并返回构造结果
- `ctx.emit('bulkhead/queued|acquired|released|rejected|timed-out', data)` — 5 个指标事件，
  依赖 cordis `Events` augmentation（module declaration 跨版本兼容性 = PCA-07 重点）
- **错误语义**：`BULKHEAD_REJECTED` / `BULKHEAD_QUEUE_TIMEOUT` / `BULKHEAD_ABORTED`，
  info.name = `BulkheadRejected|BulkheadQueueTimeout|BulkheadAborted`（遥测区分）
- **行为契约（PCA-09 断言面）**：inFlight ≤ maxConcurrent；FIFO 队头移交；
  abort 从队列移除并 settle；queueTimeout 过期 settle；rejectWhenFull 满队即拒；
  无规则命中 → 完全透传（disabled/baseline）

### src/invariant.ts — tool-bulkhead-invariant companion
| package | symbol | kind | 使用方式 |
|---|---|---|---|
| @deepseek-ai/cordis | `Context` | type | apply(ctx) |
| @deepseek-ai/dsh-invariants | `InvariantInstaller` | type | `ctx.invariants.register(PACKAGE_NAME, install)`；inject ['invariants']；返回 disposer |

## dev/test-only imports（PCA-03/08/09 用）
- tests/index.spec.ts: `Context`（cordis）、`CallId` + `ContentBlock`（dsh-llm）、
  `SystemPrompt` default（dsh-system-prompt）、`ToolRuntime` default +
  `defineContentToolFixture` + `JsonValue`（dsh-tools）
- **注意**：tests 用 `CallId`（dsh-llm 0.1.0-rc.5 旧名）——已知 dsh-llm 在 0.1.2-rc.1
  改名 `ToolCallId`（chaos PCA F2）。PCA-07/08 需确认该测试面 drift 是否同样存在。

## PCA-07 比对基线（harness git tags）
- 开发基线: harness 工作树 HEAD（app-boot 0.1.0-rc.5 era）
- 已发布最新: tag `dsh-v0.1.2-rc.1`（= npm next 0.1.2-rc.1 家族）
- 最新源码: tag `dsh-v0.1.3-alpha.1`（2026-09-04）

## PCA-09 golden 场景（bulkhead 专属）
1. 并发低于阈值 → 正常执行
2. 达到 maxConcurrent 上限 → 后续请求排队（FIFO）/ rejectWhenFull 时拒绝
3. 正在运行任务释放后 → capacity 正确恢复（inFlight 递减、队头出队执行）
4. 异常/超时任务 → 不永久占用 slot（promise.then 双挂 release）
5. disabled / 无规则命中 → 零假阳性透传
6. queueTimeout 过期 + abort 中断排队 → settle 且顺序稳定、无 starvation
