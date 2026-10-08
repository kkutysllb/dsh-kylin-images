# dsh-kylin-images

麒麟（QiLin / Kylin）与 DSH **双通道**的图像创作插件：把 awesome-gpt-image-2 的 Prompt-as-Code 样式库
与 KSkills 的图像 / 知识漫画技能，接到一个本地可执行的生成层上，并带一个专用的**「视觉模型」配置菜单**。

**状态：M1 完成**（知识数据 + 编译器 + 宿主接入 + mock 零密钥全链路 + 视觉模型配置卡），
已在**真机 dsh 宿主**上端到端验证；74 项单测全绿、strict 类型检查零错误。M2 起接真实通道。

## 一句话定位

**上游有知识没有执行器，KSkills 有流程没有编译器，我们做编译器和执行器。**

知识层（541 案例 + 22 模板的结构化检索）→ 编译器（ImagePrompt v1 → 通道请求；pitfalls 有了约束段出口、
角色表有了强制注入点、尺寸按通道 sizeStyle 三形态落地）→ 执行层（用户自配通道，落盘 + 记账 + 组装）。

## 两条硬要求（贯穿全部里程碑）

**R1 双通道**：`package.json` 同时声明 `dsh` 与 `qilin` 两套 `bundle.patch` / `client`，指向同一份
`cordis.patch.yml` 与同一份 `client.js`；设置表单一处 schema 两处用（导出 Standard Schema 的 `Config`
供 DSH 从活动 fiber 推导 + `settings.installSection` 供 QiLin 注册）。差异表见设计规格 §4.1。

**R2 专用「视觉模型」配置菜单**：通道是「怎么连」，视觉模型是「用什么画、画成什么样」。
卡片同时占用 `plugins.bundle.config`（主座席）与 `settings.section`（兜底），自带样式表（跟随 `--dsw-alias-*` 令牌）。
**凭据不进宿主设置**：非敏感字段走插件 API，API Key 只存在于 `0600` vault，界面永远只显示脱敏串。

## 安装（DSH）

    # 隔离 profile 试装（不污染日常环境）
    DSH_HOME=/tmp/dsh-kimg dsh rescue --from-default-profile web
    DSH_HOME=/tmp/dsh-kimg dsh plugin --profile rescue add /path/to/dsh-kylin-images
    DSH_HOME=/tmp/dsh-kimg dsh --profile rescue --port 45999 --no-open

    # 装进正在用的 profile
    dsh plugin --profile web add /path/to/dsh-kylin-images

麒麟引擎同理（`qilin plugin --profile qilin add …`）。装好后在插件详情页打开「视觉模型」，先加一个
`mock` 通道即可**零密钥**跑通全链路；再填 Base URL / API Key / 模型清单换成真实通道（M2 起支持真实调用）。

## 工具面

| 工具 | 作用 |
|---|---|
| `img_channels` | 通道配置与健康总览（密钥脱敏）/ 单通道自检 |
| `img_library` | 样式库与案例检索（模板 / 风格 / 场景 / 标签 / 关键词），可返回模板候选与推荐理由 |
| `img_generate` | ImagePrompt v1 → 编译（含负面清单）→ 走通道 → 落盘 → 记账，返回产物路径 |

`img_compose` / `img_batch` / `img_comic` 在 M2 / M3 交付；compose 与 generate 目前已可经 JSON API 调用。

## 快速开始（开发）

    npm install
    npm test              # 74 项：纯函数 + 存储 + 路由 + mock 全链路 + 客户端产物
    npm run typecheck     # tsc strict，零错误
    npm run build         # tsc -> lib/（宿主入口）
    npm run sync:check    # 上游数据对账（离线可跑）

## 目录

    data/          vendored 上游知识快照（style-library.json / cases.json / upstream.lock.json）
    src/prompt/    编译器：vocab / sizes / schema / negatives / compose / match
    src/library/   知识层：i18n / store（载入 + 索引 + 检索）
    src/comic/     漫画视觉选型 select.ts（P0-P10）
    src/provider/  通道层：types / mock / png（零依赖 PNG 编码器）
    src/store/     home / vault（凭据 0600 + 全出口脱敏）/ settings / spend
    src/host/      config-schema（Standard Schema）/ registry / routes（fenced JSON API）
    src/tools/     img_channels / img_library / img_generate
    client.js      「视觉模型」配置卡（双座席自注册，零构建产物）
    docs/          上游分析、设计规格、验收证据
    plans/         实施计划与 M0/M1 验收记录

## 文档

| 文档 | 内容 |
|---|---|
| [上游分析](docs/analysis/2026-10-08-awesome-gpt-image-2-analysis.md) | 资产盘点、数据模型、生成契约、缺口、许可与风险 |
| [设计规格](docs/superpowers/specs/2026-10-08-dsh-kylin-images-design.md) | 双通道契约（§4.1）、ImagePrompt v1（§5）、通道层（§7）、工具面（§8）、漫画管线（§9）、视觉模型菜单（§11.3）、里程碑（§14） |
| [M0 计划](plans/2026-10-08-m0-knowledge-and-compiler.md) · [M0 验收](plans/2026-10-08-m0-verification.md) | 知识与编译器层 |
| [M1 验收](plans/2026-10-08-m1-verification.md) | 宿主接入与视觉模型菜单；含真机 boot 抓到的两个真实缺陷与修复 |

## 上游与许可

- [freestylefly/awesome-gpt-image-2](https://github.com/freestylefly/awesome-gpt-image-2) —— MIT，vendored
  其 `data/style-library.json` 与 `data/cases.json`（commit 65a9c57a1968…）；署名与改动说明见
  [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。上游图片资产（573 文件 / 约 158 MB）不随包分发。
- KSkills `media/comic`（知识漫画 v1.1.0）与 `media/image-generation` —— 适配为插件内技能与生成工具链；
  KSkills 仓内暂无 LICENSE 文件，建议补齐。

本项目以 MIT 分发，见 [LICENSE](LICENSE)。
