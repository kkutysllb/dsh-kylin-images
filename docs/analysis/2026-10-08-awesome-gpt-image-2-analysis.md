# awesome-gpt-image-2 仓库分析

> 分析日期：2026-10-08 · 分析对象：https://github.com/freestylefly/awesome-gpt-image-2 （main @ 65a9c57）
> 分析方式：全量拉取仓库文件树（764 项）+ 关键资产原文（style-library.json / cases.json / templates.md / agent skill / 生成侧 API）
> 用途：为 dsh-kylin-images 插件的设计提供上游依据

---

## 1. 一句话结论

它不是"提示词大全"，而是一套已经做完结构化的 **Prompt-as-Code 资产库**：541 个社区案例被压缩成「22 套模板 × 19 风格 × 10 场景 × 13 分类」的双语机器可读索引，并已被作者自己打包成一个可安装的 agent skill。

对我们的价值不在"抄案例"，而在于三件事：

1. **知识层现成**：style-library.json（41 KB）是模板/风格/场景/坑位的结构化单一事实源，可直接成为插件的检索数据集；
2. **范式现成**：它验证了"原始案例 → 工业模板 → agent 技能"的三层收敛路径，以及"技能文档由数据生成、不手写第二份"的纪律；
3. **执行层缺失**：它自己是 SaaS（Supabase + Alipay + 服务端代理），没有任何可以在本地跑起来的生成能力——这正是我们要补的位置。

---

## 2. 仓库定位

作者自述的 Project Vision 讲得很清楚：

> AI 图像生成已经从"能不能出图"进入"能不能稳定、可控、可复用"；本项目把社区散例变成 Prompt-as-Code 资产。核心目标是把散文式提示词压缩成结构化协议。

两条产品线并存：

| 线 | 载体 | 面向 |
|---|---|---|
| 内容线 | data/cases.json + docs/gallery*.md + docs/templates.md | 人读：搜案例、抄模板 |
| Agent 线 | agents/skills/gpt-image-2-style-library/ + .claude-plugin/marketplace.json + npm 包 | 机读：agent 选风格写提示词 |
| 变现线 | api/ + src/ + supabase/（gpt-image2.canghe.ai） | SaaS：代充积分、代调 gpt-image-2 |

---

## 3. 资产盘点

### 3.1 知识与数据（我们真正想要的）

| 资产 | 体量 | 形态 | 可复用度 |
|---|---|---|---|
| data/style-library.json | 41 KB | 机读：version / repository / templateDocument / tagLabels(25 双语) / categories(13) / styles(19) / scenes(10) / templates(22)，每个模板含双语 title·description·useWhen·guidance[]·pitfalls[]·exampleCases[]·cover | 极高，直接作为插件数据集 |
| data/cases.json | 1.3 MB | 机读：541 条案例，字段 id/title/image/imageAlt/sourceLabel/sourceUrl/prompt/category/styles[]/scenes[]/featured/githubUrl；prompt 平均 1257 字符、最长 8143、全英文 | 高，作为检索语料 / Few-shot |
| docs/templates.md | 48 KB / 13 章 | 人读：21 套工业模板，每套三件套 =「常规模板（中文散文）+ JSON 进阶模板（推荐给 Agent 调用）+ 避坑指南」 | 高，抽成结构化产物 |
| agents/skills/…/SKILL.md | 2.4 KB | agent 技能：选型顺序（分类→风格→场景→近邻案例）、6 段提示词块、输出默认（跟随用户语言） | 极高，上游技能可直接适配 |
| agents/skills/…/references/style-library.md | 26 KB / 659 行 | 由 data/style-library.json **生成**的详解索引 | 极高，生成纪律要继承 |
| docs/gallery*.md | 808 KB | 图片画廊 + 内嵌 prompt | 低，与 cases.json 重复 |
| data/images/case*.jpg | 573 个文件 / **157.6 MB** | 案例封面 | 极低，不可随包分发，只能远端引用 |
| docs/design-qa.md、docs/design/gpt-image-2-5/ | — | 作者的设计对比与测试记录（案例输入 JSON + 记录 JSON + 预览图） | 低，方法参照 |

### 3.2 站点与商业化（我们不想要的）

api/（Vercel Functions）、supabase/migrations/（15 个迁移）、src/（161 KB 单文件 React + 65 KB CSS）、Alipay / Stripe / Watcha OAuth / GA4 / 社区付费 / 积分预留-结算事务。**这是另一个产品**，与插件无关；只有其中的"生成契约"一段值得读（见 §5）。

---

## 4. 数据模型细节

### 4.1 style-library.json —— 三层收敛的中间层

    tagLabels  : 25 个标签双语 { Art:{en,zh}, Campaign:{…}, Chart:{…}, … }
    categories : 13 项（cat-ui / cat-infographic / cat-poster / cat-product / cat-brand /
                 cat-architecture / cat-photo / cat-illustration / cat-character /
                 cat-scene / cat-history / cat-document / cat-other）
    styles     : 19 项（3d, architecture, brand, character(s), charts, classical, documents,
                 history, illustration, infographic, other, photography, poster, product(s),
                 realistic, scenes, ui）
    scenes     : 10 项（creative, tech, commerce, education, social, fashion, food, travel,
                 story, history）
    templates  : 22 项，每个模板 = 选型元数据 + 约束知识

单个 template 的字段（以 ui-screenshot-system 为例）：

    {
      "id": "ui-screenshot-system",
      "anchor": "tpl-ui",
      "cover": "/images/case17.jpg",
      "title":       { "en": "UI Screenshot System", "zh": "UI 截图系统" },
      "description": { "en": "High-fidelity app, web, dashboard, and social interface prompts.", "zh": "…" },
      "category": "UI & Interfaces",
      "styles": ["UI"], "scenes": ["Tech","Social"], "tags": ["UI","Dashboard","Screenshot"],
      "useWhen":  { "en": "…", "zh": "…" },
      "guidance": { "en": ["Lock platform, aspect ratio, layout hierarchy, and exact visible text.", …], "zh": [...] },
      "pitfalls": { "en": ["Avoid vague platform names and generic app mockups.", …], "zh": [...] },
      "exampleCases": [17, 2, 4]
    }

**这就是我们要的"提示词编译器"的约束表**：guidance 是正向必填项，pitfalls 是负向清单，exampleCases 是可回链的 few-shot。

22 套模板 id 全清单：

    ui-screenshot-system, infographic-engine, scientific-scale-diagram, poster-layout-system,
    sports-campaign-poster, conceptual-typography-poster, ink-double-exposure-poster,
    nature-science-poster, product-commerce-visual, personalized-beauty-report,
    brand-identity-package, brand-touchpoint-board, architecture-space, realistic-photography,
    street-accident-moment, illustration-art-style, character-design-sheet, 3d-collectible-toy,
    scene-storytelling, history-classical-themes, document-publishing, concept-product-breakdown

### 4.2 cases.json —— 原始案例层

    {
      "id": 544, "title": "幼儿词汇拆解学习卡", "image": "/images/case544.jpg",
      "sourceLabel": "@Naiknelofar788", "sourceUrl": "https://x.com/…",
      "prompt": "Create a clean, child-friendly educational vocabulary poster … (英文，含 [FRUIT] 占位符)",
      "promptPreview": "…", "category": "Charts & Infographics",
      "styles": ["UI","Poster","Realistic"], "scenes": ["Tech","Commerce","Education"],
      "featured": false, "githubUrl": "…/gallery-part-2.md#case-544"
    }

要点：

- **英文 prompt 是资产**（可直接作为 few-shot 或改写基底），**中文 title 是索引**（面向中文用户的检索键）。
- 案例里存在**占位符模板**（[FRUIT]/[PART]），说明一部分案例本身就是可填空模板。
- featured 仅 26 条，可作"精选样例"白名单控制上下文成本。

### 4.3 docs/templates.md —— 人读层，且藏着最有价值的东西

13 章 / 21 套模板，每套形如：

1. **常规模板**：中文散文，带 [占位符]，人可直接填空；
2. **JSON 进阶模板（推荐给 Agent 调用）**：结构化字段，机器可直接装配 —— 上游已经把"给 agent 用"的形态写出来了；
3. **避坑指南**：从失败中提炼的负向约束，例：
   - 「不要给模糊指令：明确"平台 + 比例 + 布局"」
   - 「强制文字锁定：要求"文字绝对可读，必须显示指定的中文"」
   - 「截图区分平台特征：X 有蓝勾、抖音有音乐碟片、小红书双列瀑布流」
   - 「中空界面比例锁定：车机/智能家居 21:9 必须写在最前面」

**这不只是内容，是一份"提示词质量工程"的方法论**，应原样进入我们的模板层。

---

## 5. 生成侧：唯一值得读的工程契约

站点通过 api/generate-image.js → api/_lib/apimart.js → **Apimart**（https://api.apimart.ai）以异步任务方式调用 gpt-image-2。契约（shared/apimart.js，含完整测试）：

请求

    { "model": "gpt-image-2", "prompt": "...", "n": 1, "size": "1:1", "resolution": "1k",
      "webhook": "…可选", "language": "zh|en" }

> 注意与 OpenAI 原生不同：size 是**比例字符串**（1:1），分辨率另用 resolution: 1k|2k|4k。prompt 上限 10000 字符。

响应 / 任务

- 任务 id：data[0].task_id，形如 task_[A-Za-z0-9_-]{8,180}
- 状态归一：in_progress → processing，终态 completed | failed
- 产物：data.result.images[0].url（**数组**，需归一）+ expires_at（**签名 URL 会过期 → 必须立刻下载落盘**）
- 成本：data.cost

错误分类（可直接抄进我们的错误层）

| 上游信号 | 归一码 | 语义 |
|---|---|---|
| HTTP 401 | API_KEY_INVALID | 密钥无效 |
| HTTP 402 | BALANCE_REQUIRED | 余额不足 |
| HTTP 429 | RATE_LIMITED | 限流（带 Retry-After → 1-60s 退避） |
| HTTP 400/403 或 moderation 字样 | REQUEST_REJECTED | 内容审核 / 参数拒绝 |
| HTTP ≥500 | UNAVAILABLE | 上游不可用 |
| 任务体含 balance/credit/insufficient | BALANCE_REQUIRED | 任务级余额 |
| 任务体含 rate/limit/too many | RATE_LIMITED | 任务级限流 |

价目快照：1k = $0.010625，2k = 0.0175，4k = 0.02625（可动态拉 resolution_prices 覆盖，快照日期 2026-08-28）。

**这段契约的价值**：它证明"用户自配 OpenAI 兼容中转站"这条路真实可跑，且**至少要覆盖两种请求形态**——OpenAI 原生像素尺寸（1024x1536）与聚合站比例+分辨率（1:1 + 1k）。

---

## 6. 可复用 / 不可复用 / 缺口

### 6.1 可直接复用（注意署名）

- style-library.json + cases.json（数据，MIT）
- agents/skills/gpt-image-2-style-library/（技能，MIT）
- 「由 JSON 生成技能参考文档」的脚本纪律（scripts/generate-style-skill.mjs）
- 「分类 → 风格 → 场景 → 近邻案例」的四级选型顺序，与"给 2-3 个方案让用户选"的交互约定
- Apimart 请求/响应/错误/计价契约（作为异步通道适配器的实测依据）

### 6.2 不可复用

- 图片资产：573 文件 / 157.6 MB —— **只能远端引用 + 按需缓存**，不能随包分发
- SaaS 全栈：Supabase / Alipay / Stripe / 积分事务 / 社区 —— 与本插件无关
- Vercel Functions 形态 —— 桌面插件没有服务端

### 6.3 上游缺口（= 我们的机会）

| 缺口 | 说明 | 我们的补法 |
|---|---|---|
| **没有执行器** | 技能只教"怎么写提示词"，仓库没有任何本地可跑的生成脚本；官方 npm 包只是个 skill 安装器（bin/install.mjs 拷贝文件到 ~/.codex 或 ~/.claude） | 插件内置真通道（用户自配）+ 落盘 + 成本护栏 |
| **单图视角** | 全部资产面向"一张图"，没有跨图一致性、没有序列/叙事概念 | 引入 KSkills 知识漫画的多页管线 + 三锁一致性 |
| **无负向约束出口** | pitfalls 只在文档里，没有变成请求里的 negative 字段 | 编译器把 pitfalls 编译成 negative_prompt |
| **案例检索靠人眼** | 541 条案例只有分类/风格/场景标签，无全文检索、无 token 预算控制 | img_library 工具做结构化检索 + 分页 + 摘要，避免把 26 KB 参考塞进上下文 |
| **数据无版本** | style-library.json 的 version 恒为 1，无 commit 锚点 | 插件 vendor 时钉 commit + sync-upstream --check 对账 |

---

## 7. 许可与署名（必须处理）

| 上游 | 许可 | 结论 |
|---|---|---|
| awesome-gpt-image-2 | **MIT**，Copyright (c) 2026 freestylefly | 可商用可修改，**分发时必须保留版权声明与许可全文** |
| agents/skills/gpt-image-2-style-library | 同仓 MIT（其 package.json 亦声明 MIT） | 适配需署名 + 标注改动 |
| KSkills media/comic | **仓内无 LICENSE 文件**；该 SKILL.md 走 minimal profile，未写 license 字段；metadata.kkoclaw.homepage = https://github.com/kkoclaw | 疑似自有资产 → 仍需在插件内标注来源与版本，并建议给 KSkills 补 LICENSE |

插件内需要落地：

- THIRD_PARTY_NOTICES.md：上游仓库、commit、MIT 全文、改动说明；
- 数据文件头部保留 repository 字段，并在 README 标注快照 commit；
- 技能 SKILL.md 注明 "adapted from awesome-gpt-image-2 (MIT) / KSkills comic v1.1.0"。

---

## 8. 对本插件的 8 条设计启示

1. **三层收敛照搬**：原始案例（retrieval）→ 工业模板（compiler 约束）→ agent 技能（workflow），且**技能文档由数据生成**，不手写第二份。
2. **双语是一等公民**：{en, zh} 结构 + "跟随用户语言输出"的默认，直接继承。
3. **prompt 是结构化产物**：上游 JSON 进阶模板已经暗示了 ImagePrompt 契约的存在，我们把它补成可校验的 schema。
4. **pitfalls 要有出口**：负向知识必须落到请求的 negative 字段，而不是停在文档里。
5. **选型要给选项**：模糊需求时给 2-3 个候选模板让用户选，而不是猜一个。
6. **生成契约要容忍分裂**：比例+分辨率 / 像素尺寸 / 忽略尺寸 三种模型行为都要覆盖，并提供通道探测。
7. **签名 URL 必须立刻下载**：这是上游用生产事故换来的结论（expires_at）。
8. **不搬 SaaS**：插件只做知识 + 编译 + 执行 + 落盘，不做账号、积分、支付、社区。

---

## 9. 上游风险与应对

| 风险 | 影响 | 应对 |
|---|---|---|
| 上游数据持续增长（541 → 更多），字段可能变更 | 检索结果与模板漂移 | 钉 commit 快照 + scripts/sync-upstream.mjs --check 对账；字段解析容错 |
| style-library.json.version 恒为 1 | 无法用版本号判断变更 | 用内容哈希 + commit 双重锚定 |
| 上游把技能发布到 npm（gpt-image-2-style-library@1.0.4） | 与插件内 vendored 副本重复/分叉 | 二选一：vendored 快照（可控），并在文档写明与 npm 包的关系 |
| 案例图片站外链失效 | 画廊缩略图裂图 | 图片走"远端 URL + 本地缓存"，缺失时渲染占位，不阻塞主流程 |
| 提示词内容合规（部分案例为真人肖像/品牌） | 分发风险 | 只分发 metadata（不含图片），案例回链上游画廊 |
