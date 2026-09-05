# PCA-07 — consumer-symbol audit（三 ref 比对结论）

**Date**: 2026-09-05 · **Branch**: audit/latest-dsh-compat
**比对基线**: HEAD（开发基线，0.1.0-rc.5 era）→ `dsh-v0.1.2-rc.1`（npm next）→ `dsh-v0.1.3-alpha.1`（最新源码）

## 结论：PCA-07 PASS — production 消费面无破坏性变更

| 消费 symbol | 包 | 三 ref 比对 | 结论 |
|---|---|---|---|
| `ctx.on('tools/execute', (exec, next) => Promise<ToolExecutionResult>)` | dsh-tools | 签名逐字一致（line 163/155/155） | ✅ |
| `ToolExecution` 字段（`name` / `signal: AbortSignal`） | dsh-tools | 三 ref 均存在、字段一致（bulkhead 使用面全兼容） | ✅ |
| `ToolExecutionResult` 错误形状 `{isError, content, error:{message, info:{name, code}}}` | dsh-tools | 三 ref 一致（chaos PCA-07 同款结论；bulkhead `bulkheadError()` 构造面兼容） | ✅ |
| `interface Events`（augmentation 目标） | cordis | `vendor/cordis/src/events.ts:329` 三 ref 同位置存在 | ✅ |
| `ctx.emit<K extends keyof Events>(name, ...args): void`（+ thisArg 重载） | cordis | events.ts:53/55 三 ref 逐字一致（bulkhead 的 `emit('bulkhead/*', data)` 依赖此签名） | ✅ |
| `InvariantInstaller` + `ctx.invariants.register(packageName, installer): () => void` | dsh-invariants | 三 ref 逐字一致（line 136） | ✅ |
| cordis 版本 | vendor/cordis | 4.0.1（HEAD）→ 4.0.2（两 tag）——stable patch，Events/emit 面无变化 | ✅ |
| `z`（@deepseek-ai/schemastery） | schemastery | runtime dependency（^3.18.1），非 peer；npm 解析 3.18.2（patch，无 API 面影响） | ✅ |

## Finding F2b（测试面 drift，与 chaos F2 同源）
- dsh-llm brand：基线 `CallId` → 0.1.2-rc.1 / 0.1.3-alpha.1 均为 `ToolCallId`
  （`packages/llm/llm/src/brand.ts` line 31/38，三 ref 已实证）
- 影响：**仅测试面**——`tests/index.spec.ts` 的 `import { CallId } from '@deepseek-ai/dsh-llm'`
  在 0.1.2-rc.1+ 类型下不再编译（TS2614）。bulkhead **production src 不 import CallId，零影响**。
- 最小修复（若进 patch）：测试导入改双兼容（`ToolCallId ?? CallId`，同 chaos 方案）。

## 含义
peer range 修复（候选 union）所声明的 0.1.x 兼容线，在 **API/类型层** 有证据支撑：
bulkhead 消费的 tools/execute 瀑布、ToolExecution 字段、cordis Events augmentation +
emit 签名、invariants 注册契约在 0.1.0-rc.5 era → 0.1.2-rc.1 → 0.1.3-alpha.1 全部未变。
「能安装 ≠ 能注册 ≠ 语义没变」中的前两层（安装、注册面）至此有类型层证据；
语义层由 PCA-09（runtime golden）验证。
