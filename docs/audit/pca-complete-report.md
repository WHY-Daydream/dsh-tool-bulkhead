# dsh-tool-bulkhead — Latest-DSH Compatibility Audit 报告（PCA-01 ~ PCA-10）

**Date**: 2026-09-05
**Branch**: `audit/latest-dsh-compat`（基线 main = `4de80b8`，published v0.1.0）
**状态**: **audit-first 完成，未改 production、未发布**。方法完全复用 dsh-chaos PCA 模板。
**铁律遵守**: 无 `--force` / `--legacy-peer-deps`；能安装 ≠ 能注册 ≠ 并发语义没变；
发现 breaking 先报告，不用 peer range 掩盖。

## 结论速览

| 问题 | 结论 |
|---|---|
| 当前 peer bug 是否真实存在 | ✅ 是（PCA-01 实证：2× ERESOLVE） |
| 候选 union | ✅ PCA-02 草稿（ALL PASS，见下） |
| 最新 DSH API 是否 breaking | ❌ production 无破坏；2 处测试面 drift（F2b/F2c，见下） |
| runtime golden path 是否 PASS | ✅ PCA-08/09 全绿（vitest 17/17 + golden 15/15 + companion 注册） |
| 最小 patch scope | peer union（2 peer）+ 3 处测试适配 + semver regression + CHANGELOG |
| 是否允许进入 compatibility patch release | ✅ 允许（无 runtime breaking；按 chaos v0.1.1 同款流程） |

## PCA 汇总

| Gate | 内容 | 结果 | 证据 |
|---|---|---|---|
| PCA-01 | 已发布 peer range ERESOLVE 复现 | ✅ | npm strict exit 1，2× ERESOLVE（`/tmp/bpca01/out.log`；首冲突 `peer dsh-invariants ">=0.0.1-rc.1" from bulkhead@0.1.0`） |
| PCA-02 | 候选 per-line union semver regression | ✅ ALL PASS | `/tmp/bpca02-semver.mjs`（全部已发布版本 + 0.1.3-alpha.1 in-window；0.2.x out） |
| PCA-03 | 旧开发基线 typecheck + vitest | ✅ | tsc exit 0 + vitest 17/17（基线版本：cordis 4.0.1、dsh-* 0.1.0-rc.5，见 inventory） |
| PCA-04/05/06 | 真实 npm strict 安装矩阵 | ✅ | `/tmp/bpca45/`：0.1.1-rc.2 / 0.1.2-rc.1 / 0.1.0-line(rc.8 全闭包) 均 INSTALL OK，0 ERESOLVE |
| PCA-07 | consumer-symbol audit（三 ref） | ✅ 无破坏 | `docs/audit/pca07-consumer-symbol-audit.md` |
| PCA-08 | 真实 0.1.2-rc.1 clean-room load/apply/注册 | ✅ | `/tmp/bpca08`：vitest 17/17（真实运行时）+ src-only typecheck exit 0 + invariant companion 注册 PASS |
| PCA-09 | bulkhead 专属 runtime golden | ✅ 15/15 | `/tmp/bpca08/pca09-golden.mjs`（6 场景全 PASS） |
| PCA-10 | typecheck + vitest + pack boundary + secret + clean-room tgz | ✅ | 见下 |

## PCA-02 候选 union（草稿；批准后才落入 package.json）

| peer | 已发布地板 | 候选 |
|---|---|---|
| @deepseek-ai/dsh-invariants | `>=0.0.1-rc.1` | `>=0.0.1-rc.1 <0.1.0-0 \|\| >=0.1.0-0 <0.2.0-0 \|\| >=0.1.1-0 <0.2.0-0 \|\| >=0.1.2-0 <0.2.0-0 \|\| >=0.1.3-0 <0.2.0-0` |
| @deepseek-ai/dsh-tools | `>=0.0.1-rc.1` | 同上 |
| @deepseek-ai/cordis | `>=4.0.1` | 不变（stable 线） |

仅覆盖 PCA-07/09 已验证 tuple（0.1.0/0.1.1/0.1.2/0.1.3）；0.2.x 一律 `<0.2.0-0`；
未来 0.1.4+ 须重跑验收再加成员。详见 `docs/audit/pca02-candidate-ranges.md`。

## Findings

- **F1（阻塞发布）**：peer 地板 `>=0.0.1-rc.1`（tuple (0,0,1)）不匹配任何 0.1.x prerelease 行 →
  npm strict ERESOLVE（PCA-01 实证；与 chaos 同款）。修复 = 候选 union。
- **F2b（测试面 drift，同 chaos F2）**：dsh-llm brand `CallId → ToolCallId`（0.1.0-rc.5 → 0.1.2-rc.1，
  0.1.3-alpha.1 同新名）→ `tests/index.spec.ts` 导入需双兼容适配（`ToolCallId ?? CallId`）。
  production src 不消费 CallId，零影响。
- **F2c（测试面 drift，新发现）**：dsh-tools `JsonValue` 在 0.1.2-rc.1 不再是具名导出（提示默认导入）
  → 测试 import 需适配。production src 不 import JsonValue，零影响。
- **F2d（测试面类型 nit）**：`exactOptionalPropertyTypes` 下测试构造 `domain: string | undefined`
  与 `domain?: string` 不兼容（TS2379）——测试文件类型修复，production 零影响。
- **上游组合约束（同 chaos PCA-04 结论）**：字面"全 0.1.0-rc.6 钉死"宿主不可严格构造
  （上游家族漂移，纯 host 对照 ERESOLVE）；0.1.0 线以可构造端点 rc.8（同 tuple）验证。

## PCA-09 golden 明细（真实 0.1.2-rc.1 clean-room，15/15 PASS）

A 阈值内正常执行 ✅ · B 达上限 FIFO 排队（同工具域）✅ · C 释放后 capacity 恢复 ✅ ·
B2 rejectWhenFull → `BULKHEAD_REJECTED` ✅ · D 抛错不占 slot ✅ · D2 排队中 abort →
`BULKHEAD_ABORTED` 且队列清理、后续可执行 ✅ · E disabled/无规则命中零假阳性 ✅ ·
F FIFO 顺序稳定（started=1..5）+ 无 starvation ✅

> 过程发现（已记录）：`tool:` 规则 = **per-tool domain**（不同工具名互不排队）；`maxQueue` 须 ≥1
> （fail-loud `assertLimits` 在真实运行时生效，违反即抛错——fail-loud 契约本身也被验证）。

## PCA-10 明细

- baseline typecheck exit 0 + vitest 17/17 ✅
- `why-daydream-dsh-tool-bulkhead-0.1.0.tgz`（audit 未改版本）：9 文件全在白名单内、secret NONE；
  shasum `0ce7c8c99578c27d7a9ade520e8b17ac3b45df2a`、integrity `sha512-CSH2xdLF/UTL/WGKrAS6zr5AoVSfhcpEktVlQSKY/V9KvipYc1uTkzWfgTaEBsICMspLJFl/J+EJJM26HiVn/A==`
- clean-room tgz 冒烟 PASS：打包产物可加载（exports Config/apply/name）、apply 注册
  `tools/execute`、invariant 子路径可用。注：peer 自动解析环节受本环境 registry 网络断流
  （未缓存 tarball ECONNRESET）影响，改用 `--omit=peer` 完成冒烟——peer 解析问题本身已由
  PCA-01/04/05/06 覆盖，不构成遮蔽。

## 环境说明（如实记录）
- bulkhead 自身 node_modules 为被中断的 pnpm 安装（.bin 空、.pnpm 树缺包），基线 vitest
  使用 /tmp/pca08 的健康 vitest 运行时执行（测试主体仍走 bulkhead 的 harness 链接），17/17。

## 最小 patch scope（未实施；待用户批准后按 chaos v0.1.1 流程发版）
1. `package.json`：dsh-invariants / dsh-tools 换候选 union（cordis 不变）；version 0.1.1
2. `tests/index.spec.ts`：F2b 双兼容（CallId→ToolCallId 按链接取其一）+ F2c JsonValue 适配
   + F2d exactOptionalPropertyTypes 修复
3. 新增 `tests/peer-range.spec.ts` semver regression（同 chaos）
4. `CHANGELOG.md`（[0.1.1] Latest DSH compatibility fix）
5. 发版门禁：PCA-01~10 重跑 → pack → boundary/secret → clean-room → PR → merge →
   publish exact tgz → registry clean-room → tag/GitHub Release（npm/GitHub 认证同前）
