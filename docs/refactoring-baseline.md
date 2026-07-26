# 重构基线（Refactoring baseline）

> 由 Batch **B0 基线加固**生成（见 `docs/refactoring-plan.md` §5 Phase 1）。
> 所有数字均为本机实际命令输出，非估算。运行环境：macOS 24.6.0 (darwin/arm64)、Node 22、pnpm 11.7.0、Python 3.12 / uv。
> 基线快照：commit `8df6a57`（B0 修改前）。"B0 后"列为本批改动落地后的实测值。

## 1. 验证命令与实测结果

| 命令 | B0 前 | B0 后 | 耗时（B0 后） |
|---|---|---|---|
| `pnpm typecheck` | exit 0（contracts + server） | exit 0（contracts + server + **frontend**） | 4.7s |
| `pnpm test` | exit 0，**264** tests / 44 files | exit 0，**282** tests / 46 files | 11.7s |
| `pnpm build` | exit 0 | exit 0 | 6.1s（vite 849ms） |
| `pnpm test:skills` | 命令不存在（技能测试未接入） | exit 0，**7** tests / 1 file | 0.2s |
| `cd backend && uv run pytest -q` | `49 passed, 1 skipped in 7.39s` | 未受本批影响（无 Python 改动） | 8.0s |

### 分包测试计数

| 包 | B0 前 | B0 后 | 说明 |
|---|---|---|---|
| `@pi-science/contracts` | 2 tests / 1 file | 2 / 1 | 未变 |
| `@pi-science/server` | 117 tests / 19 files | 117 / 19 | 未变 |
| `frontend` | 145 tests / 24 files | **156 / 25** | +11：`src/app/routes/LiveSessionPage.test.tsx`（首批组件测试） |
| skills（literature-review） | 7 tests / 1 file，**未被 `pnpm test` 收集** | 7 / 1，已并入 `pnpm test` | 通过新增 root script `test:skills` |
| **TS 合计** | **264**（`pnpm test` 口径） | **282** | |
| pytest（backend） | 49 passed, 1 skipped（collected 50） | 同左 | |

### pytest 计数更正

旧文档中的 **"288 pytest"** 是 NCP-029 删除前的陈旧缓存数字，与当前代码不符。
实测（`cd backend && uv run pytest -q`）：

```
..s...............................................                       [100%]
49 passed, 1 skipped in 7.39s
```

即 **collected 50 / passed 49 / skipped 1**。后续文档一律以此为准。
本机 `uv` 位于 `/Users/cyq/miniconda3/bin/uv`，可直接运行；CI 中由 `astral-sh/setup-uv@v5` + `uv sync --directory backend --extra dev` 提供。

## 2. 已知警告清单（非失败，勿在重构中"顺手修")

`pnpm build` 稳定产生以下两条警告，属于既有状态，不是回归信号：

1. **vite / rolldown chunk-size 警告**
   ```
   (!) Some chunks are larger than 500 kB after minification.
   ```
   触发者（gzip 前体积）：`vendor-openchemlib` 1,099 kB、`vendor-echarts` 1,027 kB、
   `vendor-exceljs` 930 kB、`vendor-three` 645 kB、`vendor-3dmol` 575 kB。
   均为科学可视化依赖，已按 vendor 拆包与动态 import 处理；阈值未调整。

2. **3Dmol 直接 `eval` 警告**
   ```
   [EVAL] Use of direct `eval` function is strongly discouraged
          ../node_modules/.pnpm/3dmol@2.5.5/node_modules/3dmol/build/3Dmol.js:43198:20
   ```
   来自第三方包源码，本仓库无法在不 fork 的前提下消除。

3. **`pnpm test`（frontend）Node 警告**
   ```
   ExperimentalWarning: localStorage is not available because --localstorage-file was not provided
   ```
   Node 层面的提示；测试自身在 jsdom / stub 下运行 localStorage，不影响结果。

4. **pytest**：1 个 skip（`..s...`）。

## 3. B0 补齐的基线缺口

| 缺口（plan §2） | 处理 |
|---|---|
| frontend 无 `typecheck` script，root/CI 不覆盖前端 | `frontend/package.json` 新增 `"typecheck": "tsc -p tsconfig.app.json --noEmit"`；root `typecheck` 追加 `pnpm --filter frontend typecheck`；`quality.yml` 步骤名同步 |
| 文献技能测试在 vitest 收集范围外 | root 新增 `test:skills`，并追加到 root `test` 链；CI 的 `pnpm test` 因此自动覆盖 |
| 旧文档 pytest 计数错误（288） | 见 §1 更正为 50（49 passed / 1 skipped） |
| 零组件测试、无 testing-library | 引入 `@testing-library/react` / `user-event` / `jest-dom`（决策 D1）；`vitest.config.ts` 增加 `setupFiles: ["./src/test-setup.ts"]` |
| 5 个最高风险 UI 行为无测试 | 新增 `frontend/src/app/routes/LiveSessionPage.test.tsx`（11 个 characterization tests，见 §4） |

## 4. Characterization tests（固化现状，不修行为）

`frontend/src/app/routes/LiveSessionPage.test.tsx` — 11 个用例，覆盖 plan §3「5 个最高风险未测 UI 行为」：

| 行为 | 代码位置（commit 8df6a57） | 用例 |
|---|---|---|
| a. 发送失败恢复 | `LiveSessionPage.tsx:275-316` | 拒绝时恢复 draft + workspace references；用户已重新输入时**不**覆盖 draft（references 仍恢复） |
| b. IME Enter 守卫 | `LiveSessionPage.tsx:318-327`、`522-523` | `nativeEvent.isComposing`、`composingRef`、`compositionend` 的 `setTimeout(0)` 三段各自抑制；之后 Enter 发送；Shift+Enter 不发送 |
| c. 回合完成副作用 | `LiveSessionPage.tsx:107-123` | 历史回放（`working` 从不为 true）不开 inspector、不产生 suggestions；`working` true→false + 新 agent block 恰好开一次并渲染 suggestions；同一 block 不重复触发 |
| d. model 切换乐观回滚 | `LiveSessionPage.tsx:167-208` | 乐观切到 `prov/m2` 且 thinking clamp 到 `medium`；保存失败后 model 与 thinking 双双回滚并显示 modelError；thinking 单独切换失败同样回滚 |
| e. slash 命令分发 | `LiveSessionPage.tsx:229-273` | `/compact` POST `/api/sessions/{id}/compact?cwd=…` 并显示 "Session compacted"；`/name <x>` 写入本地 session name 并显示 "Session renamed to <x>"；未知 `/xyz …` 落回普通 send |

设计约定：
- 每组用例都是**双向**断言（既断言触发、也断言不触发），避免空测试。
- 不使用快照；在模块边界打桩（`fetch`、`ModelControlMenu`），其余走真实 zustand store，与 `runtime-store.test.ts` 的做法一致。
- 稳定性：`vitest run src/app/routes/LiveSessionPage.test.tsx` 连续 3 次均为 `11 passed`。

### 与 plan 记述不一致处（已按现状固化）

- plan 把行为 e 写作「`/rename` renames + toasts」。实际命令名是 **`/name`**，且它设置的是组件内的 `reviewNotice` 文本，**不走 toast**。测试按实际行为编写。
- plan 记 composer 发送失败恢复在 `~L270-316`，实际 `handleSend` 起于 **L275**；其余行号与 plan 一致。

## 5. 未纳入 `pnpm test` 的验证资产

以下仍需手动/单独运行，B0 未改动其接入状态：

| 资产 | 命令 |
|---|---|
| 控制平面 smoke | `pnpm smoke`（CI 已含） |
| UAT ×4 | `pnpm --filter frontend test:uat:{conversation,knowledge,notebook,office}`（**未进 CI**） |
| bundle 预算 | `pnpm --filter frontend test:bundle` |
| lint | `pnpm --filter frontend lint`（oxlint，**未进 CI**） |

## 6. 环境注意事项

本机 `node_modules/.modules.yaml` 记录的 pnpm store 指向已不存在的 `<repo>/.pnpm-store/v11`，
导致 `pnpm add` 报 `ERR_PNPM_UNEXPECTED_STORE`。B0 期间将其重指向默认 store
`~/Library/pnpm/store/v11` 后安装成功。这是本机环境状态，不涉及仓库文件；
CI 使用干净 `pnpm install --frozen-lockfile`，不受影响。
