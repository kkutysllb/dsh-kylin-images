# dsh-kylin-images 设计规格（草案 v0.1）

> 日期：2026-10-08 · 状态：**待需求方确认**（未开始实现）
> 关联：[awesome-gpt-image-2 仓库分析](../../analysis/2026-10-08-awesome-gpt-image-2-analysis.md)
> 参考实现：dsh-video-generator（通道层 / run 状态机 / vault）、dsh-super-ppts（设置页自配置模式 / 能力通告）、dsh-skills-bundle（runtime skill 注册）

## 1. 定位

**麒麟基座的图像创作插件**：把两处已有的知识资产（awesome-gpt-image-2 的 Prompt-as-Code 样式库、KSkills 的图像与知识漫画技能）接到一个**本地可执行**的生成层上，形成"选型 → 编译 → 生成 → 落盘 → 组装"的闭环。

一句话：**上游有知识没有执行器，KSkills 有流程没有编译器，我们做编译器和执行器。**

三条产品线：

| 线 | 面向 | 交付物 |
|---|---|---|
| 单图线 | "帮我画一张 X" | 结构化提示词 → 一张（或 n 张变体）落盘图片 |
| 知识漫画线 | "把这段内容画成漫画" | 多页叙事漫画项目（分镜 + 角色一致性 + 逐页出图 + 联系表/PDF） |
| 样式库线 | "什么风格/模板适合这个需求" | 可检索的模板/风格/场景/案例知识（人读工作台 + 机读工具） |

**明确不做**：账号、积分、支付、社区、SaaS 站点（上游那一整套与插件无关）。

## 2. 关键决策（2026-10-08 已确认）

> 需求方已确认：**D1 = B（全量，分阶段交付）**、**D2 = 用户自配 OpenAI 兼容通道**、**D3 = 宿主侧实现知识漫画管线**、**D4 = vendored 上游快照**。
> 另加两条硬要求，贯穿全部里程碑：
> **(R1) 插件必须是 dsh 与 kylin（QiLin）双向双通道**——同一份 bundle 与 client 交付物在两个宿主上都可安装、可渲染、行为一致；
> **(R2) 插件必须带一个专用「视觉模型」配置菜单**——用于配置视觉模型本身（选哪个模型、走哪个通道、生成默认值、预设），而不只是配通道。

### 2.1 决策表

| # | 决策点 | 选项 | 建议 |
|---|---|---|---|
| D1 | 插件形态 | A 纯技能包（只有 SKILL.md + 数据，无生成）/ B 知识+生成+工作台（全量）/ C 只做生成层，漫画流程留给技能文档 / D 先 M0-M1 骨架验证再定 | **B，但分阶段交付**（M0/M1 先落地，M2+ 按反馈继续） |
| D2 | 生成通道 | ① 用户自配 OpenAI 兼容通道（三要素）② 薄封装 KSkills 的 Python 脚本 ③ 两者并存 | **①为主**，②只作为"已有环境变量用户"的兼容读入，不引入 Python 运行时依赖 |
| D3 | 知识漫画管线的宿主实现程度 | ① 只出 SKILL.md，agent 自由发挥 ② 宿主侧项目状态机 + schema 校验 + 批量渲染 + 三锁一致性 | **②**（否则 §9.5 列出的 10 个缺陷一个都修不掉） |
| D4 | 样式库分发方式 | ① 随包 vendored 快照（钉 commit）② 运行时拉上游 ③ 引 npm 包 | **①**（离线可用、可对账；②作为可选更新通道） |

## 3. 心智模型：三层知识 + 一个编译器

    上游资产                        本插件层                        产物
    ─────────────────────────────────────────────────────────────────────────
    541 案例 (cases.json)   ┐
    22 模板 (style-library) ┼──▶  知识层 (library)  ──检索──▶  选型建议 (2-3 候选)
    21 工业模板 (templates) ┘         │
                                      ▼
    KSkills comic 6 步流程  ──▶  流程层 (comic)    ──编排──▶  项目状态机
                                      │
                                      ▼
                              编译器 (compose)     ──▶  通道请求 (prompt+negative+size)
                                      │
                                      ▼
                              执行层 (provider)    ──▶  落盘图片 + 记账 + 联系表

**编译器是本插件的核心资产**：把「结构化 ImagePrompt」确定性地翻译成「通道请求」。它让上游的 pitfalls 有了出口（negative_prompt）、让漫画的角色表有了强制注入点（三锁）、让同一份输入可复现（可测）。

## 4. 总体架构

    dsh-kylin-images/
    ├── package.json                # dsh + qilin 双通道 manifest（bundle.patch / client.inject）
    ├── cordis.patch.yml
    ├── src/
    │   ├── host/index.ts           # cordis apply(ctx)：注入 tools / webServer，注册工具与路由
    │   ├── provider/               # 通道层
    │   │   ├── types.ts            # ImageProvider 接口 + capabilities + assertProvider
    │   │   ├── openai-images.ts    # 同步：POST {base}/images/generations → b64/url
    │   │   ├── task-images.ts      # 异步：提交→taskId→轮询→url[]+expires_at（Apimart 形态）
    │   │   ├── mock.ts             # 零 key 全链路（本地生成占位 PNG）
    │   │   ├── probe.ts            # /models 枚举 + 鉴权 + 小额实跑
    │   │   └── pricing.ts          # 三层查价 + 预算阈值
    │   ├── prompt/                 # 编译器层
    │   │   ├── schema.ts           # ImagePrompt v1 的 JSON Schema 与校验器
    │   │   ├── compose.ts          # ImagePrompt → ProviderRequest（纯函数）
    │   │   ├── match.ts            # 需求 → 模板/风格/场景候选（纯函数）
    │   │   ├── negatives.ts        # pitfalls → negative_prompt
    │   │   └── sizes.ts            # 比例/分辨率/像素三种 sizeStyle 的映射
    │   ├── library/                # 知识层（读 vendored 数据）
    │   │   ├── store.ts            # 载入 + 索引（分类/风格/场景/关键词）
    │   │   ├── search.ts           # 结构化检索 + 分页 + token 预算
    │   │   └── i18n.ts             # {en,zh} 取值与语言跟随
    │   ├── comic/                  # 知识漫画管线
    │   │   ├── project.ts          # 项目状态机 + comic.json
    │   │   ├── select.ts           # P0-P10 视觉方案自动选型（纯函数，可测）
    │   │   ├── storyboard.ts       # 分镜 schema 校验
    │   │   └── assemble.ts         # 联系表 HTML（零依赖）+ 可选 PDF
    │   ├── tools/                  # img_* 工具面
    │   ├── store/                  # vault（通道凭据）+ projects（项目状态）+ spend（记账）
    │   └── client/                 # 设置页 tab + 侧边栏「图像工坊」
    ├── data/
    │   ├── style-library.json      # vendored（MIT，署名）
    │   ├── cases.json              # vendored（MIT，署名）
    │   └── upstream.lock.json      # {commit, sha256, syncedAt}
    ├── skills/                     # runtime skills（宿主登记，见 §10）
    │   ├── gpt-image-2-style-library/{SKILL.md,references/style-library.md}
    │   ├── knowledge-comic/SKILL.md
    │   └── image-prompt-protocol/SKILL.md
    ├── scripts/
    │   ├── sync-upstream.mjs       # 拉上游 → vendor → 生成 references（--check 对账）
    │   └── gen-skill-references.mjs
    ├── test/                       # node --test
    └── docs/

依赖方向严格单向：tools → comic/prompt → provider/library → store。client 不引任何重型依赖（不引 xyflow、不引 chromium）。

### 4.1 双通道适配契约（R1）

manifest 同时声明 dsh 与 qilin 两套键，指向**同一份** cordis.patch.yml 与 client 交付物：

    "dsh":   { "bundle": { "patch": "./cordis.patch.yml" },
               "client": { "platform": "web", "inject": [ ... ] } },
    "qilin": { "bundle": { "patch": "./cordis.patch.yml" },
               "client": { "platform": "web", "inject": [ ... ] } }

两个宿主的差异点已由 dsh-kylin-memory 与 dsh-video-generator 用真机验证过，本插件照抄结论：

| 面 | DSH | QiLin（麒麟） | 本插件的做法 |
|---|---|---|---|
| bundle 装配 | 读 dsh.bundle.patch | **只认 qilin.bundle.patch**（缺失报"没有声明组合包"） | 两键都写，同一文件 |
| 设置表单来源 | 设置服务从活动 fiber 自带的 Config 导出**推导** | 设置服务**只认** settings.installSection 注册过的 | 宿主侧两条都做：导出 Config + dynamicInject 探测 settings.installSection（缺失静默跳过），一处 schema 两处用 |
| 设置卡片座席 | settings.section 导航（0.1.x 系） | plugins.bundle.config 座席 + configForms 服务 | **主配置面走 settings.section（设置页面菜单）**；插件详情页另挂同一份表单的 plugins.bundle.config 卡片；不占 workspace 侧边栏 |
| 表单原语 | 宿主设置原语在 QiLin 已不存在 | 同左 | 卡片自带样式表（--dsw-alias-* / --dsw-radius-* + 字面量兜底），不依赖宿主表单组件 |
| 兼容门 | peer 范围 >=0.1.0-rc.5 <1.0.0 \|\| >=3.0.0 <4.0.0 | 同左 | 全部 optional，防止 pnpm 把引擎树拉进用户 profile |

客户端入口契约（对齐 dsh-kylin-memory 的已验证实现）：

    export const inject = ["slots", "locale", "configForms"]
    ctx.slots.inject("plugins.bundle.config", () => ctx.slots.register(
      { name: "plugins.bundle.config", key: SETTINGS_NS, locale: LOCALE_NS,
        inject: () => ({ self: ctx.configForms.get(SETTINGS_NS) }) },
      VisionModelConfigCard))
    // 提交语义：一批 { op: 'set' | 'unset', path: [field] } + 读到的 revision 作为 CAS 前置
    // 字段"被覆盖"当且仅当 key 出现在 state.user；未覆盖走宿主默认

**凭据不进宿主设置**：configForms 只承载非敏感字段（模型、通道 id、默认分辨率/比例/质量、预设、负面清单、阈值）；API Key 一律走插件自己的 fenced API + 0600 vault，卡片内渲染 password 输入，回显只有脱敏串。理由：宿主设置可能被导出/同步/打印，而 vault 有 0700/0600 + 全出口脱敏的既有纪律。

## 5. 核心契约：ImagePrompt v1

**这是插件对外的唯一提示词协议**，上游 22 套模板、漫画技能的分页 JSON、用户自然语言，最终都收敛到这里。

    {
      "schemaVersion": 1,
      "id": "comic-2026-10-08-turing/page-03",
      "intent": "single-image | comic-page | variant-set | edit",
      "templateId": "infographic-engine",
      "subject": "图灵在深夜的密码室突然意识到天气报文格式固定",
      "composition": {
        "layout": "cinematic",
        "shot": "low-angle close-up",
        "panels": ["窗外暴雨", "桌上电报堆", "图灵抬头瞬间"],
        "hierarchy": ["人物神情", "电报特写", "环境氛围"]
      },
      "style": {
        "artStyle": "ligne-claire",
        "tone": "dramatic",
        "tags": ["Poster","Realistic"],
        "materials": ["flat color fill","clean uniform outlines"]
      },
      "text": [
        { "content": "你还不休息？", "kind": "speech-bubble", "speaker": "琼·克拉克", "mustRenderExactly": true }
      ],
      "characters": [
        { "name": "图灵", "sheet": "mid-30s man, lean build, round wire-rimmed glasses, …", "refImage": "assets/turing-sheet.png" }
      ],
      "technical": { "aspectRatio": "3:4", "resolution": "2k", "format": "png", "seed": 12345 },
      "constraints": { "must": ["…"], "avoid": ["photorealistic rendering","3D CGI","anime screentones"] },
      "language": "zh",
      "meta": { "source": "user|case:544|template:infographic-engine", "notes": "…" }
    }

**compose() 的确定性规则**（纯函数，golden-file 测试）：

1. 组装顺序固定：风格序言 → 主体与场景 → 构图与分镜 → 角色表（逐字注入）→ 画面内文字（逐字 + must render exactly）→ 技术参数 → 负向约束；
2. constraints.avoid ∪ 模板 pitfalls（按 templateId 查表）∪ 用户负向词 → negative_prompt；
3. technical → 按通道 × 模型的 sizeStyle 映射：pixels（1024x1536）/ ratio-resolution（1:1 + 1k）/ ignore；
4. 语言规则：画面内文字用源语言，提示词主体英文（与上游技能一致）；language 只影响工具返回的说明文案；
5. 输出同时附**可读预览**（人可复制的最终 prompt），生成前不花钱。

## 6. 知识层（library）

- **数据**：vendored style-library.json + cases.json，头部保留上游 repository 与 commit；
- **索引**：按 category / style / scene / tag / 关键词（title + prompt 倒排）建内存索引，进程内构建一次（41 KB + 1.3 MB 量级，可接受）；
- **检索接口**：searchLibrary({query, category, styles, scenes, tags, limit, cursor}) → 返回**摘要**（模板 id/title/useWhen/pitfalls + 命中案例的 id/title/promptPreview），默认不返回全文 prompt（token 预算由调用方显式 include: 'prompt' 打开）；
- **候选建议**：suggestTemplates(need) 按「分类 → 风格标签 → 场景标签 → 近邻案例」四级打分返回 2-3 个候选（对齐上游技能的交互约定），并给出**为什么**（命中了哪些标签）；
- **图片**：不分发图片文件，只给上游 image 路径拼出的远端 URL；工作台按需下载到缓存目录，失败渲染占位。

## 7. 通道层（provider）

对齐 dsh-video-generator §4：**零站点硬编码**，通道三要素由用户在设置页自配。

    interface ImageProvider {
      readonly kind: 'openai-images' | 'task-images' | 'mock'
      capabilities(): { maxPromptChars, supportsNegative, supportsReferenceImage,
                        supportsSeed, sizes: SizeStyle, models: string[] }
      quote(spec): { amount: number, currency: string, confidence: 'exact'|'estimated'|'unknown' }
      generate(spec, signal): Promise<{ images: Array<{ path: string, meta: object }>, cost?, raw }>
      status?(jobId): Promise<JobStatus>
      health(): Promise<{ ok: boolean, models?: string[], detail?: string }>
    }

- **两种 profile**：
  - openai-images（同步）：POST {base}/v1/images/generations，请求 {model, prompt, n, size:"1024x1536", quality, response_format}；响应取 data[0].b64_json 或 data[0].url（兼容 KSkills 现有脚本与视频插件附录 B.3 实测的 seedream 签名 URL 形态）；
  - task-images（异步）：提交 → task_id → 轮询 → data.result.images[0].url[] + expires_at（Apimart 形态，见分析 §5）；
- **落盘铁律**：拿到 URL 立即下载到项目目录，**不存 URL 当产物**（签名 URL 会过期）；
- **超时与退避**：所有 fetch 带 AbortController + 超时；429/5xx 指数退避（基期 30s，封顶 15min），尊重 Retry-After；
- **模型目录两层**：内置按名称模式推断（gpt-image-*、doubao-seedream-*、qwen-image-*、wan*.image、z-image-*、grok-imagine-image、gemini/*-image、flux…）+ 用户覆盖；每条含 sizeStyle / supportsNegative / supportsReferenceImage / 价目；
- **探测**：GET /models 枚举 + 鉴权校验 + **小额实跑**（写回该通道的能力结论）；设置页「测试通道」按钮走这条；
- **成本护栏**：每次生成前 quote()；预估 > 阈值（默认 ¥1，可改）经 DSH ask 确认；**未知价一律确认**；每笔记账到项目（通道/模型/分辨率/张数/成本）；
- **缓存**：sha256(channelId|model|composedPrompt|size|resolution|seed) 命中已有文件则跳过（除非 force）—— 漫画重渲染只补失败页的关键。

## 8. 工具面（img_*）

| 工具 | 入参要点 | 职责 | 花费 |
|---|---|---|---|
| img_library | query / category / styles / scenes / tags / limit / include | 样式库与案例检索，返回摘要 + 候选模板（含推荐理由） | 0 |
| img_compose | ImagePrompt JSON 或自然语言 + templateId | 编译 + 校验 + 预览最终 prompt / negative / size；不触碰通道 | 0 |
| img_generate | ImagePrompt / prompt / channel / n / force | 单次生成（可 n 变体），落盘 + 返回图片内容块 + 记账 | 有 |
| img_batch | items[] / concurrency / resume | 批量生成（多页/多变体），逐项状态、失败重试、断点续跑 | 有 |
| img_comic | action: open/plan/render/status/assemble | 知识漫画项目全生命周期（见 §9） | 视 action |
| img_channels | action: list/test/quote | 通道健康、模型清单、价目与累计消耗 | 0（test 有小额） |

统一契约：全部带 output.schema；img_generate / img_comic(render) 通过 render 返回**图片内容块**（会话模型可直接看图自评），批量时**分批返回**（默认每批 ≤4 张）避免一次塞十几张图进上下文。

## 9. 知识漫画管线

### 9.1 项目布局

    <workspace>/comic/<slug>/
    ├── comic.json          # 状态机：stage / 视觉方案 / 页清单 / 角色表 / 通道 / 记账
    ├── source.md           # 源内容（用户给或检索来）
    ├── analysis.md         # 会话模型产出
    ├── characters.md       # 角色设定（三锁的文字来源）
    ├── storyboard.md       # 分镜
    ├── prompts/NN-page.json# ImagePrompt v1（插件校验 + 编译）
    ├── images/NN-page.png  # 产物
    ├── contact-sheet.html  # 零依赖联系表
    └── <slug>-comic.pdf    # 可选

slug 规则与冲突处理沿用 KSkills 技能（kebab-case 2-4 关键词；已存在则追加时间戳）。

### 9.2 工具动作与职责边界

**插件零 LLM 调用**（继承 dsh-video-generator 的已确认决策）：分析/角色/分镜三段由会话模型产出，插件只做**校验 + 落盘 + 注入 + 执行 + 组装**。

| action | 做 | 不做 |
|---|---|---|
| open | 建目录 + 按 §9.3 规则给出默认视觉方案（可覆盖）+ 源内容处理（有文件读文件；只给主题则**要求先补内容**，并提示可用 web_search 后由模型写入 source.md） | 不自己搜网、不自己写分析 |
| plan | 校验 analysis / characters / storyboard 三段 JSON 或 Markdown 结构 → 落盘 → 缺哪段报哪段（含"下一步该产出什么"的指引） | 不生成内容 |
| render | 逐页编译 prompt（角色表逐字注入 + 风格序言固定 + pitfalls → negative）→ 生成 → 落盘 → 分批返回图片 | 不自评质量 |
| status | 各页状态 / 成本 / 失败原因 / 断点续跑指引 | — |
| assemble | contact-sheet.html（零依赖）+ 可选 PDF | 不做重型排版 |

### 9.3 自动选型（把技能里的 P0-P10 表变成代码）

上游 KSkills comic 技能给了一张「内容信号 → 风格/色调/布局」的优先级表。插件把它实现为**纯函数 selectVisualPlan(signals)**：

- P0 用户显式指定（最高优先，覆盖一切）；
- P1-P10 顺序匹配：武侠/仙侠/中国历史 → P2 计算机/AI/编程 → P3 1950 前历史 → P4 冲突/突破/革命 → P5 美食/商业/生活方式 → P6 校园/青春/情感 → P7 个人故事/导师叙事 → P8 教程/入门/操作指南 → P9 传记均衡 → P10 科普/百科；
- 输出 {artStyle, tone, layout, aspectRatio, matchedRule, confidence}，并**永远把命中的规则与理由返回给模型**，让模型可以解释或覆盖。

**这是插件相对 KSkills 原技能最直接的增益之一**：原来靠模型每次读表自由判断，现在有确定、可回归测试的实现。

### 9.4 三锁一致性（相对 KSkills 的实质增强）

原技能只有"文字锁"。本插件做三锁：

| 锁 | 机制 | 说明 |
|---|---|---|
| 文字锁 | characters.md → 每页 characters[].sheet 逐字注入 | 继承原技能，但由编译器保证不被模型改写 |
| 图像锁 | 先生成一张角色三视图卡，后续页把它作为 reference image 传入（通道支持时） | 新增；通道 capabilities.supportsReferenceImage 为假时自动降级并在 status 里说明 |
| 风格锁 | 项目级固定 artStyle/tone/layout/aspectRatio + 逐页同一段风格序言字符串 | 新增；保证跨页风格 token 完全一致 |

### 9.5 相对 KSkills 现有实现的缺陷修复清单

在对比 KSkills media/comic/SKILL.md 与 media/image-generation/scripts/generate.py 后，确认以下 10 处需要在插件里闭环：

| # | 现有缺陷 | 后果 | 本插件的修复 |
|---|---|---|---|
| 1 | 漫画技能产出 JSON prompt，但 generate.py 把文件**当纯文本整体读入** | 实际会把 JSON 源码当提示词发出去 | compose() 解析 ImagePrompt 并生成真正的 prompt |
| 2 | 脚本不支持 negative_prompt | 模板 pitfalls / 漫画 negative_prompt 全部落空 | 编译器统一出口 |
| 3 | 无异步任务（长任务）支持 | 部分模型/中转站只提供任务式接口 | task-images 适配器 + 轮询 |
| 4 | 无超时/退避/重试策略 | 网络抖动直接失败 | fetch 超时 + 指数退避 + 尊重 Retry-After |
| 5 | 无并发、无断点续跑（技能给的是 bash for 循环） | 20 页漫画中途失败要重跑 | img_batch 并发 + 按页状态续跑 |
| 6 | 无成本护栏 | 20 页 × 2k 图无声烧钱 | quote + 阈值确认 + 记账 |
| 7 | 路径写死 /mnt/skills/public、/mnt/user-data | 换宿主即崩 | 工作区相对路径 + QILIN_HOME 兜底 |
| 8 | 依赖 Python + requests + PIL | 引入额外运行时 | 零依赖 Node ≥24（全局 fetch） |
| 9 | 参考图只在 gpt-image2 分支生效，gemini 分支忽略 | 行为不一致 | 能力位声明 + 统一注入 |
| 10 | 组装（PDF）留给模型现写 PIL/img2pdf | 每次重新发明 | 内置零依赖联系表 |

## 10. 技能面（runtime skills）

复用 dsh-skills-bundle 的形态（ctx.skills.register({name, description, source:'runtime', content, resourceBase})，正文剥离 frontmatter，资源按技能目录解析）：

| 技能 | 来源 | 注册策略 |
|---|---|---|
| gpt-image-2-style-library | 上游 MIT，适配 | **core**（激活即注册，描述里指向插件内 references 资源） |
| knowledge-comic | KSkills comic v1.1.0，适配 | **core** |
| image-prompt-protocol | 自研（ImagePrompt v1 契约 + 何时用工具） | **core** |
| 长尾样式补充（可选） | 上游 cases 精选子集 | **optional**（默认不注册，设置页启用） |

要点：

- **零目录税**：注册的只是 name + description，26 KB 的 references 是 resourceBase 资源，按需读；
- 技能内所有路径改为工作区相对路径，并声明"生成一律走 img_* 工具，不要自己拼通道请求"；
- 技能与工具的分工写死在技能正文：**技能负责流程与判断，工具负责编译与执行**。

## 11. 客户端

### 11.1 设置面总览

| tab | 内容 |
|---|---|
| 通道管理 | 通道列表（label + 脱敏 key + 启用开关 + 默认标记）、三要素表单（password 输入、提交即清空、列表只显示脱敏串）、**测试通道**按钮（枚举模型 / 鉴权 / 端点风格结论）、模型能力与价目覆盖、预算阈值、默认并发与分辨率 |
| 图像设置 | 默认比例/分辨率/格式、负面清单全局追加、缓存开关与目录、样式库数据版本（commit + 同步时间） |

写操作走 fenced JSON API：POST /dsh-kylin-images/api/<method>，信封 {ok,value} / {ok,error:{code,message}}，Host 回环信任边界（DNS-rebind 防御），JSON body，无 shell 拼接。

### 11.2 侧边栏「图像工坊」

零重型依赖（沿用 dsh-skills-bundle 的 ModuleLoader / jsx-runtime shim 形态）：

- **画廊**：按分类/风格/场景筛选样式库模板与精选案例（缩略图远端按需加载 + 本地缓存）；点选生成"选型建议"投递到会话；
- **项目产物**：comic 项目列表 + 逐页缩略图 + 状态徽章 + 成本 + 一键打开联系表；3s 轮询仅在工作台可见时启动；
- **样式库版本**：commit / 同步时间 / 一键更新（调用宿主 API）。

### 11.3 专用「视觉模型」配置菜单（R2）

这是插件的**主配置面**，标题「视觉模型」，以 settings.section 注册为**设置页面里的菜单项**（dsh 与 kylin 同一份代码）；同一份表单也挂在插件详情页的 plugins.bundle.config 座席上。**不注册 workspace 侧边栏座席。**它不是"通道管理"的别名：通道是**怎么连**，视觉模型是**用什么画、画成什么样**。

分区（自上而下）：

| 区 | 字段 | 类型 / 座席 |
|---|---|---|
| **1 当前视觉模型** | 通道（下拉，来自 vault 的通道列表）· 模型（下拉，来自该通道模型目录 ∪ 用户覆盖）· 能力徽章（负向 / 参考图 / 种子 / 尺寸风格 / prompt 上限） | 字符串，configForms |
| **2 生成默认值** | 默认比例（1:1 / 3:4 / 4:3 / 16:9 / 9:16 / 2:3 / 3:2）· 默认分辨率（1k / 2k / 4k，或像素档）· 默认格式（png / jpeg / webp）· 质量（low / medium / high，按模型能力显隐）· n（变体数）· 并发 | configForms |
| **3 视觉预设（preset）** | 命名预设列表，每条 = {名称, 通道, 模型, 比例, 分辨率, 质量, 负面清单追加, 说明}；内置三档：漫画分页（3:4 / 2k / png）、高清信息图（4:3 / 2k / png）、快速草稿（1:1 / 1k / low）；工具以 preset 名调用 | configForms（数组） |
| **4 负面与约束** | 全局追加负面词（自由文本，逗号或换行分隔）· 是否把模板 pitfalls 自动并入 negative（默认开）· 画面内文字强制策略（锁定 / 提示） | configForms |
| **5 成本与缓存** | 预算阈值（超过则该次生成先确认）· 未知价是否一律确认（默认是）· 缓存开关 · 缓存目录 · 缓存上限 | configForms |
| **6 通道与凭据** | 通道增删改（label / kind / baseUrl / models[]）· API Key（password，提交即清空，列表仅回显脱敏串）· 「测试通道」按钮 → /api/…/channels.test（枚举模型 + 鉴权 + 小额实跑结论）· 高级：端点路径覆盖、超时、退避 | 插件 fenced API + vault |

交互纪律（继承 dsh-kylin-memory 的卡片语义）：

- 本地暂存 → 一次批量提交（{op:'set'|'unset', path:[field]} + 读到的 revision），失败保留用户输入并提示；
- 被覆盖的字段显示「已覆盖」+「恢复默认」；
- 只读部署显示「本部署的设置为只读」，插件未加载显示「该插件当前未加载」；
- 卡片自带样式（km-/kimg- 前缀），跟随 --dsw-alias-* 令牌，亮暗双主题一致；
- 摘要座席（view === 'summary'）返回 null，标题与一句话由 Plugins 页自绘。

「测试通道」返回的可读结论（写回该通道配置，卡片上直接展示）：

    { ok, models: [...], auth: 'ok'|'invalid', endpointStyle: 'sync-images'|'task-images',
      sizeStyle: 'pixels'|'ratio-resolution'|'ignore', realRun: { tried, ok, note, cost } }

### 11.4 侧边栏「图像工坊」（原 11.2 保留）

- **vault**：QILIN_HOME/.dsh-kylin-images/vault.json（跟随宿主 home，兜底 ~/.dsh-kylin-images/），目录 0700 / 文件 0600，tmp+rename 原子写；内容 = 通道列表 + 默认通道 + 预算阈值 + 偏好；**全出口 maskCredential**（前 3 + •••• + 后 3），并有断言测试"响应字符串不含明文 key"；
- **projects**：comic/<slug>/comic.json 为事实源（重启不丢），带保留策略与清理命令；
- **缓存**：<cache>/images/<hash>.<ext>，可配置上限；
- **入口校验**：Base URL 强制 https、key 长度上限、通道 id 白名单正则、prompt 长度上限按模型 capability 校验；
- **不下发**：任何路由不回显凭据；错误信息脱敏；无个人路径硬编码。

## 13. 测试与验证

- **mock provider 零 key 全链路**为硬门槛：本地生成占位 PNG（纯 Node 手写最小 PNG，不引图像库），跑通「选型 → 编译 → 生成 → 落盘 → 联系表」全链路；
- **纯函数火力点**（golden-file）：
  - P0-P10 选型：每种内容信号各 1 例 + 用户覆盖 1 例；
  - sizeStyle 三形态映射（pixels / ratio-resolution / ignore）；
  - compose() 组装顺序与负面清单合并（含模板 pitfalls 注入）；
  - 缓存键稳定性（同输入同键、改分辨率变键）；
  - 检索打分与分页边界；
  - vault 脱敏断言（响应不含明文 key）；
  - 上游数据对账（sync-upstream --check 退出码）；
- **契约测试**：两条通道 profile 的请求体/响应解析用固定 fixture（Apimart 形态取自上游实测记录）；
- **真机验证阶梯**：M2 单图真机 → M3 三页漫画真机（人眼 + 会话自评双验）→ M4 十页一致性；
- 宿主路由/工具变更必须用最小隔离 profile 真机 boot + curl round-trip（沿用 dsh-video-generator 的验证规则）。

## 14. 里程碑

| 阶段 | 内容 | 出口标准 |
|---|---|---|
| **M0**（0.5-1 天） | 仓库骨架 + vendored 上游数据 + 署名文件 + sync-upstream.mjs（含 --check）+ 纯函数层（match / sizes / compose / selectVisualPlan）+ 单测 | node --test 全绿；对账脚本可断言行；零网络 |
| **M1**（1-2 天） | 插件骨架：双通道 manifest + cordis apply + vault（通道 CRUD + 脱敏 + /api 操作面）+ mock provider + 记账 + 设置页「通道管理」tab | 真机 boot 后 /health 在线；通道增删改测全通；mock 全链路出图 |
| **M2**（2-3 天） | 真通道：openai-images（同步）+ task-images（异步）+ 探测 + 成本护栏 + img_library / img_compose / img_generate / img_batch | 真机单图出图并落盘（预算内）；限流/失败路径有可读错误 |
| **M3**（3-5 天） | 知识漫画：img_comic 全动作 + 三个 runtime skill 注册 + 三锁一致性 + 联系表 | 真机 3 页知识漫画端到端（跨页角色一致，人眼通过） |
| **M4**（2-3 天） | 侧边栏「图像工坊」+ 设置页「图像设置」+ 可选 PDF + 文档与发布 | 零 key demo（mock）+ 真机 demo 双达标；README/规范齐备 |

## 15. 风险与开放问题

| 风险 | 概率 | 影响 | 应对 |
|---|---|---|---|
| 上游数据漂移 / 字段变更 | 中 | 检索与模板失效 | 钉 commit 快照 + 内容哈希对账 + 解析容错 |
| 通道形态分裂（像素 / 比例+分辨率 / 忽略） | 高 | 尺寸不符合预期 | sizeStyle 能力位 + 探测期小额实跑写回结论 |
| 中文出字质量（漫画对白必须准确） | 高 | 成品可用性 | 提示词逐字锁定 + 每页文字清单 + 失败页重绘 +（二期）图像编辑模型修字 |
| 成本（20 页 × 2k） | 中 | 用户被烧钱 | quote 前置 + 阈值确认 + 缓存去重 + 记账可见 |
| 图像锁依赖通道支持参考图 | 中 | 一致性降级 | 能力位声明 + 自动降级 + status 明示当前锁级别 |
| KSkills 无 LICENSE、上游 MIT 署名遗漏 | 低 | 合规 | THIRD_PARTY_NOTICES + 技能内标注 + 建议 KSkills 补 LICENSE |
| 上下文预算（一次返回多页图） | 中 | 会话上下文爆掉 | 分批返回 + 摘要 + 工作台看图 |
| 与 dsh-skills-bundle 的技能重名 | 低 | 注册冲突 | 技能名前缀或依赖 registry 的覆盖规则 |

**开放问题（待需求方定）**：

1. 侧边栏工作台进不进 MVP？（建议 M4，先工具 + 设置页）
2. 是否需要 PDF，还是联系表 HTML 足够？
3. 默认通道默认值：内置 gpt-image-2 / seedream 两档建议配置，还是完全留空强制用户先测通道？
4. 是否需要"图生图/修图"（edit）能力进 MVP？（建议二期，但 schema 预留 intent: edit 与 referenceImages）

## 16. 不做清单（YAGNI）

- 账号 / 积分 / 支付 / 社区 / 排行榜（上游 SaaS 的全部）
- 多账号轮换池（保留记账接口，池化二期）
- 节点画布工作台（重前端依赖的历史教训）
- 自建模型推理 / 本地扩散（只做通道编排）
- 图片管理大库（只做项目级产物与一个小缓存）
- 把 157 MB 案例图片随包分发
