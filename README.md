# dsh-kylin-images

麒麟（QiLin / Kylin）与 DSH **双通道**的图像创作插件：把 awesome-gpt-image-2 的 Prompt-as-Code 样式库
与 KSkills 的知识漫画流程，接到一个本地可执行的生成层上，并带一个专用的**「视觉模型」配置菜单**。

**状态：M0-M4 完成**。134 项单测全绿、tsc strict 零错误；已在**真机 dsh 宿主**上完成真实付费端到端验证
（单图 + 3 页知识漫画，含跨页角色一致性与中文对白逐字渲染）。

## 一句话定位

**上游有知识没有执行器，KSkills 有流程没有编译器，我们做编译器和执行器。**

知识层（541 案例 + 22 模板的结构化检索）→ 编译器（ImagePrompt v1 → 通道请求）→
执行层（用户自配通道：探测 → 查价 → 确认 → 生成 → 落盘 → 记账 → 缓存）→
流程层（知识漫画项目：分镜编译 + 三锁一致性 + 逐页出图 + 联系表）。

## 两条硬要求

**R1 双通道**：package.json 同时声明 dsh 与 qilin 两套 bundle.patch / client，指向同一份
cordis.patch.yml 与 client.js；设置表单一处 schema 两处用（Standard Schema 的 Config 供 DSH 推导
+ settings.installSection 供 QiLin 注册）。差异表见设计规格 §4.1。

**R2 专用「视觉模型」配置菜单**：通道是「怎么连」，视觉模型是「用什么画、画成什么样」。
**入口在设置页面**：以 settings.section 注册「视觉模型」设置页菜单（主入口），并在插件详情页提供同一份表单的配置卡；**不占用 workspace 侧边栏**（配置属于设置页，不属于工作区侧栏）。自带样式表；
含通道与模型、生成默认值、全局负面词、成本阈值与缓存、测试通道（探测 + 可选小额实跑）、累计消耗与缓存命中。
**凭据不进宿主设置**：API Key 只存在于 0600 vault，界面永远只显示脱敏串。

## 通道类型

| kind | 协议 | 适用 |
|---|---|---|
| mock | 本地占位图，零密钥零网络 | 上手、CI、全链路自检 |
| openai-images | 同步：POST {base}/v1/images/generations，回 b64_json 或 url | OpenAI 官方与多数兼容端点 |
| openai-responses | 同步：POST {base}/v1/responses + tools:[{type:image_generation, size, quality}]，回 output[].result 的 base64 | 把 images 端点挡掉、只放行 Responses 的聚合站（实测 tianyuai.lol） |
| task-images | 异步：提交 -> task_id -> 轮询（/v1/tasks/{id}，可覆盖）-> 签名 URL | 聚合站（Apimart 形态等） |

尺寸风格三形态自动适配：pixels（1024x1536）/ ratio-resolution（1:1 + 1k）/ ignore（模型自决）。
**签名 URL 一律立刻下载落盘。**

## 成本护栏与缓存

- 三层查价：通道覆盖 > 内置模型目录 > unknown；未知价一律先确认（可关）；超阈值（默认 ¥1）先确认；每笔记账。
- 确认语义：工具返回确认请求，模型带 confirm=true 重调；批量预检只报价不生成（dryRun），不会重复烧钱。
- 结果缓存：内容哈希命中即复用（命中时把文件复制到本次产物目录），漫画重渲染只补失败页。

## 工具面（6 个）

| 工具 | 作用 |
|---|---|
| img_channels | 通道总览（密钥脱敏）/ test 健康 / probe 探测（模型枚举 + 鉴权 + 端点风格 + 可选小额实跑） |
| img_library | 样式库与案例检索（模板 / 风格 / 场景 / 标签 / 关键词），可返回模板候选与推荐理由 |
| img_compose | **只编译不生成**：预览最终提示词 / 负面清单 / 通道尺寸字段（零成本） |
| img_generate | ImagePrompt v1 -> 编译 -> 成本护栏 -> 缓存 -> 生成 -> 落盘 -> 记账 |
| img_batch | 批量（页 / 变体）：受限并发、逐项记账、失败不拖垮整批、命中缓存即跳过 |
| img_comic | 知识漫画全流程：open / plan / sheet / render / status / assemble |

## 知识漫画的三锁一致性

| 锁 | 机制 |
|---|---|
| 文字锁 | 角色表逐字注入每页 ImagePrompt（只注入本页出场的角色） |
| 风格锁 | 项目级 artStyle/tone/layout/宽高比 + 全篇同一句 must 前言 |
| 图像锁 | 先生成角色三视图，后续页把它作为参考图注入 |

## 随包 runtime 技能

- knowledge-comic：知识漫画流程（何时用、六步、三锁、画面文字语言）
- gpt-image-2-style-library：样式库选型（匹配顺序、候选让用户选、常见坑）
- image-prompt-protocol：ImagePrompt v1 契约与工具分工

## 安装与验证

    # 隔离试装（不污染日常环境）
    DSH_HOME=/tmp/dsh-kimg dsh rescue --from-default-profile web
    DSH_HOME=/tmp/dsh-kimg dsh plugin --profile rescue add /path/to/dsh-kylin-images
    DSH_HOME=/tmp/dsh-kimg dsh --profile rescue --port 45999 --no-open

    # 常用 profile
    dsh plugin --profile web add /path/to/dsh-kylin-images

麒麟引擎同理（qilin plugin --profile qilin add ...）。
**完整的人工验证清单见 [docs/install-and-verify.md](docs/install-and-verify.md)**（含 11 个验收点与排障表）。

## 快速开始（开发）

    npm install
    npm test              # 164 项：纯函数 + 存储 + 协议适配器 + 路由 + 漫画 + 客户端产物
    npm run typecheck     # tsc strict，零错误
    npm run build         # tsc -> lib/（git 安装由 prepare 自动构建）
    npm run sync:upstream:check   # 上游数据对账（离线可跑）
    npm run sync:mirror   # 同步 dsh-plugins 分发镜像（需 ../dsh-plugins 仓存在）
    npm run sync:check    # 镜像对账：与 ../dsh-plugins 零差异
    npm run release:notes # 把 release/vX.Y.Z.md 同步为 GitHub Release（需 gh 登录）

## 目录

    data/          vendored 上游知识快照（style-library.json / cases.json / upstream.lock.json）
    src/prompt/    编译器：vocab / sizes / schema / negatives / compose / match
    src/library/   知识层：i18n / store（载入 + 索引 + 检索）
    src/comic/     漫画：select（P0-P10 选型）/ project（状态机）/ plan（分镜编译）/ assemble / service
    src/provider/  通道层：types / errors / http / catalog / pricing / mock / png / openai-images / openai-responses / task-images
    src/store/     home / vault（凭据 0600 + 全出口脱敏）/ settings / spend / cache
    src/host/      config-schema（Standard Schema）/ registry / routes（fenced API + 产物路由）/ generate（生成编排）
    src/tools/     六个 img_* 工具
    skills/        三个 runtime skill（随包分发，激活即注册）
    client.js      设置页菜单「视觉模型」+「图像工坊」+ 插件详情页配置卡（零构建产物）
    docs/          上游分析、设计规格、安装验证清单、验收证据
    plans/         逐里程碑的实施计划与验收记录

## 文档

| 文档 | 内容 |
|---|---|
| [安装与验证清单](docs/install-and-verify.md) | 人工在 dsh 与麒麟桌面端安装验证的 11 个验收点与排障表 |
| [上游分析](docs/analysis/2026-10-08-awesome-gpt-image-2-analysis.md) | 资产盘点、数据模型、生成契约、缺口、许可与风险 |
| [设计规格](docs/superpowers/specs/2026-10-08-dsh-kylin-images-design.md) | 双通道契约（§4.1）、ImagePrompt v1（§5）、通道层（§7）、工具面（§8）、漫画管线（§9）、视觉模型菜单（§11.3） |
| [M0 验收](plans/2026-10-08-m0-verification.md) · [M1 验收](plans/2026-10-08-m1-verification.md) · [M2 验收](plans/2026-10-08-m2-verification.md) · [M3/M4 验收](plans/2026-10-08-m3-verification.md) | 逐里程碑证据与缺陷记录 |

## 上游与许可

- [freestylefly/awesome-gpt-image-2](https://github.com/freestylefly/awesome-gpt-image-2) —— MIT，vendored
  其 data/style-library.json 与 data/cases.json（commit 65a9c57a1968...）；署名与改动说明见
  [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。上游图片资产（573 文件 / 约 158 MB）不随包分发。
- KSkills media/comic（知识漫画 v1.1.0）与 media/image-generation —— 适配为插件内技能与生成工具链；
  KSkills 仓内暂无 LICENSE 文件，建议补齐。

本项目以 MIT 分发，见 [LICENSE](LICENSE)。
