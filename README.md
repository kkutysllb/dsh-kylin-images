# dsh-kylin-images

麒麟（QiLin / Kylin）与 DSH **双通道**的图像创作插件：把 awesome-gpt-image-2 的 Prompt-as-Code 样式库
与 KSkills 的图像 / 知识漫画技能，接到一个本地可执行的生成层上，并带一个专用的**「视觉模型」配置菜单**。

**状态：M2 完成（含真实密钥端到端实跑）** —— 知识数据 + 编译器 + 宿主接入 + 视觉模型菜单 + **真实通道（同步 / 异步）** + 通道探测
+ 成本护栏 + 结果缓存 + 批量生成。109 项单测全绿、strict 类型检查零错误，并在**真机 dsh 宿主**上端到端验证。

## 一句话定位

**上游有知识没有执行器，KSkills 有流程没有编译器，我们做编译器和执行器。**

知识层（541 案例 + 22 模板的结构化检索）→ 编译器（ImagePrompt v1 → 通道请求；pitfalls 进约束段、
角色表逐字注入、尺寸按通道 sizeStyle 三形态落地）→ 执行层（用户自配通道，探测 → 查价 → 确认 → 生成 → 落盘 → 记账 → 缓存）。

## 两条硬要求（贯穿全部里程碑）

**R1 双通道**：`package.json` 同时声明 `dsh` 与 `qilin` 两套 `bundle.patch` / `client`，指向同一份
`cordis.patch.yml` 与同一份 `client.js`；设置表单一处 schema 两处用（导出 Standard Schema 的 `Config`
供 DSH 从活动 fiber 推导 + `settings.installSection` 供 QiLin 注册）。差异表见设计规格 §4.1。

**R2 专用「视觉模型」配置菜单**：通道是「怎么连」，视觉模型是「用什么画、画成什么样」。
卡片同时占用 `plugins.bundle.config`（主座席）与 `settings.section`（兜底），自带样式表；
包含通道与模型、生成默认值、全局负面词、成本阈值与缓存、**测试通道（探测 + 可选小额实跑）**、累计消耗与缓存命中。
**凭据不进宿主设置**：非敏感字段走插件 API，API Key 只存在于 `0600` vault，界面永远只显示脱敏串。

## 通道类型

| kind | 协议 | 适用 |
|---|---|---|
| `mock` | 本地占位图，零密钥零网络 | 首次上手、CI、全链路自检 |
| `openai-images` | 同步：`POST {base}/v1/images/generations`，回 `b64_json` 或 `url` | OpenAI 官方与多数兼容端点 |
| `openai-responses` | 同步：`POST {base}/v1/responses` + `tools:[{type:'image_generation', size, quality}]`，回 `output[].result` 的 base64 | 把 images 端点挡掉、只放行 Responses 的聚合站（实测 tianyuai.lol） |
| `task-images` | 异步：提交 → `task_id` → 轮询（`/v1/tasks/{id}`，可覆盖）→ 签名 URL | 聚合站（Apimart 形态等） |

尺寸风格三形态自动适配：`pixels`（1024x1536）/ `ratio-resolution`（`1:1` + `1k`）/ `ignore`（模型自决）。

> 真实端点实测（2026-10-08）：`https://tianyuai.lol` 把 `/v1/images/generations` 在 nginx 层直接 403，图片模型只能走 `/v1/responses` + `image_generation` 工具——这正是 `openai-responses` 通道类型的由来。同一轮真实出图里，中文对白「时间戳怎么全一样？」逐字正确渲染（见 [docs/evidence](docs/evidence)）。
**签名 URL 一律立刻下载落盘**（上游 URL 带 `expires_at`）。

## 成本护栏与缓存

- 三层查价：**通道覆盖 > 内置模型目录 > unknown**；未知价一律先确认（可关）；超过阈值（默认 ¥1）先确认；每笔记账。
- 确认语义：工具/接口返回确认请求，模型带 `confirm=true` 重调；批量在**预检阶段只报价不生成**（dryRun），不会重复烧钱。
- 结果缓存：内容哈希（通道×模型×提示词×负面×尺寸×分辨率×张数×种子）命中即复用，命中时把文件复制到本次产物目录；
  漫画重渲染只补失败页；`useCache:false` 强制重跑；`cache.prune/clear` 可管理。

## 工具面

| 工具 | 作用 |
|---|---|
| `img_channels` | 通道总览（密钥脱敏）/ `test` 健康 / `probe` 探测（模型枚举 + 鉴权 + 端点风格 + 可选小额实跑） |
| `img_library` | 样式库与案例检索（模板 / 风格 / 场景 / 标签 / 关键词），可返回模板候选与推荐理由 |
| `img_compose` | **只编译不生成**：预览最终提示词 / 负面清单 / 通道尺寸字段（零成本，生成前先审阅） |
| `img_generate` | ImagePrompt v1 → 编译 → 成本护栏 → 缓存 → 生成 → 落盘 → 记账 |
| `img_batch` | 批量（漫画逐页 / 多变体）：受限并发、逐项记账、失败不拖垮整批、命中缓存即跳过、可断点续跑 |

`img_comic`（知识漫画管线）在 M3 交付。

## 安装（DSH）

    # 隔离 profile 试装（不污染日常环境）
    DSH_HOME=/tmp/dsh-kimg dsh rescue --from-default-profile web
    DSH_HOME=/tmp/dsh-kimg dsh plugin --profile rescue add /path/to/dsh-kylin-images
    DSH_HOME=/tmp/dsh-kimg dsh --profile rescue --port 45999 --no-open

    # 装进正在用的 profile
    dsh plugin --profile web add /path/to/dsh-kylin-images

麒麟引擎同理（`qilin plugin --profile qilin add …`）。装好后在插件详情页打开「视觉模型」：
先加 `mock` 通道零密钥跑通全链路，再填 Base URL / API Key / 模型清单并用「测试通道」探测；
真实通道上线前建议先 `probe`（不实跑）确认鉴权与端点风格，再决定是否小额实跑。

## 快速开始（开发）

    npm install
    npm test              # 109 项：纯函数 + 存储 + 协议适配器 + 路由 + 客户端产物
    npm run typecheck     # tsc strict，零错误
    npm run build         # tsc -> lib/（宿主入口；git 安装由 prepare 自动构建）
    npm run sync:check    # 上游数据对账（离线可跑）

## 目录

    data/          vendored 上游知识快照（style-library.json / cases.json / upstream.lock.json）
    src/prompt/    编译器：vocab / sizes / schema / negatives / compose / match
    src/library/   知识层：i18n / store（载入 + 索引 + 检索）
    src/comic/     漫画视觉选型 select.ts（P0-P10）
    src/provider/  通道层：types / errors / http / catalog / pricing / mock / png / openai-images / task-images
    src/store/     home / vault（凭据 0600 + 全出口脱敏）/ settings / spend / cache
    src/host/      config-schema（Standard Schema）/ registry / routes（fenced JSON API）/ generate（生成编排）
    src/tools/     img_channels / img_library / img_compose / img_generate / img_batch
    client.js      「视觉模型」配置卡（双座席自注册，零构建产物）
    docs/          上游分析、设计规格、验收证据
    plans/         实施计划与 M0/M1/M2 验收记录

## 文档

| 文档 | 内容 |
|---|---|
| [上游分析](docs/analysis/2026-10-08-awesome-gpt-image-2-analysis.md) | 资产盘点、数据模型、生成契约、缺口、许可与风险 |
| [设计规格](docs/superpowers/specs/2026-10-08-dsh-kylin-images-design.md) | 双通道契约（§4.1）、ImagePrompt v1（§5）、通道层（§7）、工具面（§8）、漫画管线（§9）、视觉模型菜单（§11.3）、里程碑（§14） |
| [M0 验收](plans/2026-10-08-m0-verification.md) · [M1 验收](plans/2026-10-08-m1-verification.md) · [M2 验收](plans/2026-10-08-m2-verification.md) | 逐里程碑的证据与缺陷记录 |

## 上游与许可

- [freestylefly/awesome-gpt-image-2](https://github.com/freestylefly/awesome-gpt-image-2) —— MIT，vendored
  其 `data/style-library.json` 与 `data/cases.json`（commit 65a9c57a1968…）；署名与改动说明见
  [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。上游图片资产（573 文件 / 约 158 MB）不随包分发。
- KSkills `media/comic`（知识漫画 v1.1.0）与 `media/image-generation` —— 适配为插件内技能与生成工具链；
  KSkills 仓内暂无 LICENSE 文件，建议补齐。

本项目以 MIT 分发，见 [LICENSE](LICENSE)。
