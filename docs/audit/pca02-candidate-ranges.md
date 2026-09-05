# PCA-02 — 候选 peer range 草稿 + semver regression（audit-only 草稿）

**Date**: 2026-09-05 · **Branch**: audit/latest-dsh-compat
**铁律**: 仅草稿。每个 tuple union member 只有在 PCA-07/PCA-09 证明该 DSH 线
API/runtime 兼容后才允许进入正式 peer range（no member without evidence）。

## 候选 range（dsh-tool-bulkhead 的 peerDependencies）

bulkhead 的 peer 面比 chaos 简单：无 timeout-policy 类独立 peer。

| peer | 已发布地板 | PCA-02 候选（per-line union） |
|---|---|---|
| @deepseek-ai/dsh-invariants | `>=0.0.1-rc.1` | `>=0.0.1-rc.1 <0.1.0-0 \|\| >=0.1.0-0 <0.2.0-0 \|\| >=0.1.1-0 <0.2.0-0 \|\| >=0.1.2-0 <0.2.0-0 \|\| >=0.1.3-0 <0.2.0-0` |
| @deepseek-ai/dsh-tools | `>=0.0.1-rc.1` | 同上 |
| @deepseek-ai/cordis | `>=4.0.1` | 不变（stable 4.0.x 线，无 prerelease-tuple 问题；无上界为既有语义） |

设计要点（同 chaos PCA-02 模板）：
- 保留旧地板成员 `>=0.0.1-rc.1 <0.1.0-0` → 0.0.1 线旧宿主继续可装（PCA-03 兼容）
- 每条已验证 0.1.x prerelease 行一个显式成员：0.1.0（rc.x）、0.1.1（rc.x）、0.1.2（alpha/rc）、
  0.1.3（源码 alpha.1）——**只覆盖 PCA-07/09 验证过的 tuple，不承诺未来 0.1.4+**
- `0.2.x` 一律被 `<0.2.0-0` 排除；稳定版 0.1.x 由 `>=0.1.0-0` 成员自然覆盖
- npm semver 元组规则：候选 prerelease 须与同 set 内某比较器共享 major.minor.patch tuple

## Semver regression（脚本暂存 /tmp/bpca02-semver.mjs，未入 production）

矩阵覆盖每个 peer 的**全部 npm 已发布版本** + 源码 `0.1.3-alpha.1`（expect true）+
`0.0.1-rc.0`（低于地板）/ `0.2.0-alpha.1` / `0.2.0`（expect false）→ **ALL PASS**。

- 每行已发布 prerelease：true ✅（0.0.1-rc.1..rc.5、0.1.0-rc.2..rc.8、0.1.1-rc.1/rc.2、
  0.1.2-alpha.2..5、0.1.2-rc.1）
- `0.1.3-alpha.1`：true ✅
- `0.2.0-alpha.1` / `0.2.0` / `0.0.1-rc.0`：false ✅
- cordis `>=4.0.1`：4.0.1 / 4.0.2 / 4.1.0 → true ✅（无上界既有语义）
