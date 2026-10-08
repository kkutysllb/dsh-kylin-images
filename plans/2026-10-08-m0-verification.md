# M0 验收记录（知识与编译器层）

> 日期：2026-10-08 · 计划：[plans/2026-10-08-m0-knowledge-and-compiler.md](./2026-10-08-m0-knowledge-and-compiler.md)
> 结论：**M0 出口标准全部达成**。零网络依赖的纯函数层与 vendored 知识数据已落地并通过全部验收命令。

## 1. 验收命令与实测输出

### 1.1 单元测试（47 项全绿）

    $ node --test test/*.test.ts
    ℹ tests 47
    ℹ pass 47
    ℹ fail 0

覆盖：尺寸三形态映射、提示词编译分段顺序与负面清单出口、角色表逐字注入、画面文字锁定、
双语取值、分类/关键词检索、分页游标、坏数据容错、模板候选打分与兜底、
漫画 P0-P10 选型、上游 lock 对账、许可署名。

### 1.2 类型检查（strict，零错误）

    $ npm run typecheck
    (tsc -p tsconfig.all.json --noEmit，无任何输出)

### 1.3 上游数据对账

    $ npm run sync:check
    checked style-library.json 80f5cae039d0 {"templates":22,"categories":13,"styles":19,"scenes":10}
    checked cases.json a9ef652dffda {"cases":541,"totalCases":541}
    上游对账通过：commit 65a9c57a1968，syncedAt 2026-10-08T16:00:13.646Z

## 2. 交付物清单

| 类别 | 文件 |
|---|---|
| 数据 | data/style-library.json（41 KB）、data/cases.json（1.3 MB）、data/upstream.lock.json |
| 合规 | LICENSE、THIRD_PARTY_NOTICES.md（上游 MIT 全文 + commit + 改动说明） |
| 双通道骨架 | package.json（dsh 与 qilin 两键都声明，patch 指向同一文件）、cordis.patch.yml |
| 编译器 | src/prompt/{vocab,sizes,schema,negatives,compose,match}.ts |
| 知识层 | src/library/{i18n,store}.ts |
| 漫画选型 | src/comic/select.ts |
| 工具链 | scripts/sync-upstream.mjs（pin / --check）、tsconfig.json、tsconfig.all.json |
| 测试 | test/{prompt-sizes,prompt-compose,library-search,comic-select,upstream-lock}.test.ts |

## 3. 与规格的对应

| 规格条目 | 状态 | 证据 |
|---|---|---|
| §2 R1 双通道 manifest | 完成（安装期验证属 M1） | package.json 两键同 patch |
| §5 ImagePrompt v1 + compose() 确定性规则 | 完成 | test/prompt-compose.test.ts 14 项 |
| §6 知识层检索（摘要优先、分页、双语） | 完成 | test/library-search.test.ts 11 项 |
| §7 sizeStyle 三形态 | 完成 | test/prompt-sizes.test.ts 7 项 |
| §9.3 P0-P10 视觉选型 | 完成 | test/comic-select.test.ts 10 项 |
| §13 上游对账 + 署名 | 完成 | test/upstream-lock.test.ts、npm run sync:check |

## 4. M0 明确未做（属 M1-M4）

- cordis 宿主接入（apply / tools / webServer 路由）—— M1
- vault 与通道凭据、/api 操作面 —— M1
- 「视觉模型」设置菜单（plugins.bundle.config 座席 + configForms）—— M1
- 真通道适配（同步 / 异步）与探测、成本护栏 —— M2
- 知识漫画 img_comic 工具与 runtime skill 注册 —— M3
- 侧边栏工作台与技能参考文档生成 —— M4

## 5. 已知限制

- 本包当前**不可安装**：package.json 已声明 main/exports 指向 lib/（M1 产出），dsh/qilin 插件行在 cordis.patch.yml 中仍为注释态。
- 检索为 OR 分词匹配（召回优先）；若后续要精确短语匹配，应在 store.ts 显式引入 AND/短语模式，而不是改测试期望。
- 测试只覆盖纯函数；真实通道契约（请求体/响应解析）的 fixture 测试从 M2 开始。
