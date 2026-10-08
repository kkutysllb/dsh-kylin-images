# dsh-kylin-images M0 实施计划（知识与编译器层）

**Goal:** 落地插件的"零成本地基"——vendored 上游知识数据、上游对账脚本、以及全部纯函数层（样式选型、尺寸映射、提示词编译、漫画视觉选型）与单测；**零网络、零密钥、无宿主依赖**。

**Architecture:** 本插件是 dsh 与 kylin(QiLin) 双向双通道 bundle，核心资产是一个确定性编译器：把唯一的 ImagePrompt v1 契约编译成通道请求。M0 只做纯函数与数据，不接宿主、不发请求，让后续 M1-M4 有可回归测试的地基。

**Tech Stack:** Node >= 24（原生 .ts 类型擦除 + node:test）、TypeScript 5.9（strict / erasableSyntaxOnly / NodeNext）、零运行时依赖。

---

## 文件结构（M0 交付）

| 文件 | 职责 |
|---|---|
| package.json | 包元数据 + dsh/qilin 双通道 manifest + scripts |
| cordis.patch.yml | bundle 层（M1 才插宿主插件行，M0 先占位） |
| tsconfig.json / tsconfig.all.json | 构建与全量类型检查 |
| LICENSE / THIRD_PARTY_NOTICES.md | MIT 全文与上游署名（合规硬要求） |
| data/style-library.json | vendored 上游样式库（MIT） |
| data/cases.json | vendored 上游案例库（MIT） |
| data/upstream.lock.json | commit + 两文件 sha256 + 同步时间 + 来源 URL |
| scripts/sync-upstream.mjs | 拉取/对账（--check 只读断言，零网络亦可跑对账） |
| src/library/i18n.ts | {en,zh} 取值，容错 |
| src/library/store.ts | 载入 + 建索引 + 结构化检索 |
| src/prompt/schema.ts | ImagePrompt v1 类型 + 校验器（手写，零依赖） |
| src/prompt/sizes.ts | sizeStyle 三形态映射 |
| src/prompt/negatives.ts | 约束块与负面清单合并 |
| src/prompt/compose.ts | 编译器：ImagePrompt → 通道请求 |
| src/prompt/match.ts | 需求 → 模板候选（四级打分） |
| src/comic/select.ts | P0-P10 视觉方案选型（纯函数） |
| test/*.test.ts | 上述全部纯函数的回归测试 |

---

## Task 1: 仓库骨架与许可

**Files:** Create package.json, tsconfig.json, tsconfig.all.json, cordis.patch.yml, LICENSE, THIRD_PARTY_NOTICES.md

- [x] **Step 1:** 写 package.json，dsh 与 qilin 两键都声明 bundle.patch 与 client（同一份交付物）。
- [x] **Step 2:** 写 tsconfig（target ES2022 / module NodeNext / strict / erasableSyntaxOnly / rewriteRelativeImportExtensions / noUncheckedIndexedAccess）。
- [x] **Step 3:** 写 LICENSE（本项目 MIT）与 THIRD_PARTY_NOTICES.md（上游 MIT 全文 + commit + 改动说明 + KSkills 适配说明）。
- [x] **Step 4:** 验证：node -e "JSON.parse(require('fs').readFileSync('package.json'))" 成功；两键存在。

## Task 2: vendored 数据与对账

**Files:** Create data/style-library.json, data/cases.json, data/upstream.lock.json, scripts/sync-upstream.mjs

- [x] **Step 1:** 从上游 raw 拉 data/style-library.json 与 data/cases.json 落到 data/。
- [x] **Step 2:** 写 data/upstream.lock.json：{ repository, commit: 65a9c57a1968a13f2f1997c58409cac9aa146bc7, files: { "style-library.json": {sha256, bytes, count}, "cases.json": {sha256, bytes, count} }, syncedAt }。
- [x] **Step 3:** 写 scripts/sync-upstream.mjs：默认拉取并重写 lock；--check 只读比对磁盘文件 sha256 与 lock，断言结构（templates/categories/styles/scenes/cases 计数）并输出差异。
- [x] **Step 4:** 验证：node scripts/sync-upstream.mjs --check 退出码 0。

## Task 3: 编译器纯函数层（TDD）

**Files:** Create src/library/i18n.ts, src/prompt/schema.ts, src/prompt/sizes.ts, src/prompt/negatives.ts, src/prompt/compose.ts; Test: test/prompt-sizes.test.ts, test/prompt-compose.test.ts

- [x] **Step 1:** 写 test/prompt-sizes.test.ts：pixels 形态产出 1024x1536（3:4）、ratio-resolution 产出 {size:"1:1",resolution:"2k"}、ignore 产出空对象。
- [x] **Step 2:** 运行 node --test test/prompt-sizes.test.ts，期望 FAIL（模块不存在）。
- [x] **Step 3:** 实现 src/prompt/sizes.ts 至通过。
- [x] **Step 4:** 写 test/prompt-compose.test.ts：断言组装顺序（风格序言 → 主体 → 构图 → 角色表 → 画面文字 → 技术 → 约束）、角色表逐字注入、constraints.avoid 进 negative、模板 pitfalls 进约束块而非 negative、缺字段产生 warning。
- [x] **Step 5:** 实现 schema.ts / negatives.ts / compose.ts 至通过。
- [x] **Step 6:** 运行 node --test 全绿。

## Task 4: 知识检索层

**Files:** Create src/library/store.ts, src/prompt/match.ts; Test: test/library-search.test.ts

- [x] **Step 1:** 写测试：按 category+style 过滤、关键词命中、分页游标、prompt 默认不返回全文（include:'prompt' 才返回）。
- [x] **Step 2:** 实现 store.ts（buildLibrary 纯函数 + loadLibrary 读盘）与 match.ts（四级打分返回 2-3 候选 + 命中理由）。
- [x] **Step 3:** 用真实 vendored 数据跑一次断言行：templates 22 / categories 13 / styles 19 / scenes 10。
- [x] **Step 4:** node --test 全绿。

## Task 5: 漫画视觉选型

**Files:** Create src/comic/select.ts; Test: test/comic-select.test.ts

- [x] **Step 1:** 写测试：P0 用户指定覆盖一切；P1 武侠→ink-brush/dramatic/splash；P2 计算机→ligne-claire/neutral/dense；P8 教程→chalk/neutral/dense；P10 科普→ligne-claire/warm/webtoon；无命中返回默认并标注。
- [x] **Step 2:** 实现规则表与匹配（纯函数，返回 matchedRule/priority/reason）。
- [x] **Step 3:** node --test 全绿。

## Task 6: 验收

- [x] **Step 1:** npm run typecheck（tsc -p tsconfig.all.json --noEmit）通过。
- [x] **Step 2:** npm test（node --test test/*.test.ts）全绿。
- [x] **Step 3:** node scripts/sync-upstream.mjs --check 通过。
- [x] **Step 4:** 记录 M0 出口证据（命令 + 输出）到 plans/2026-10-08-m0-verification.md。

---

## 与规格的对应

| 规格条目 | 覆盖任务 |
|---|---|
| §2 R1 双通道 manifest | Task 1 |
| §6 知识层 | Task 2、Task 4 |
| §5 ImagePrompt v1 + compose | Task 3 |
| §7 sizeStyle 三形态 | Task 3 |
| §9.3 P0-P10 选型 | Task 5 |
| §13 测试策略（纯函数火力点） | Task 3/4/5/6 |
| §13 上游对账 | Task 2、Task 6 |

**M0 不做**：cordis 宿主接入、vault、通道适配器、img_* 工具、client 配置卡（均属 M1-M4）。

> 执行说明：本计划的 Task 1-6 在当前会话内联执行（非 subagent 分派），完成后按 Task 6 逐条跑验收命令并记录证据。
