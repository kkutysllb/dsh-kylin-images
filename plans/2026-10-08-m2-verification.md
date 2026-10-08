# M2 验收记录（真实通道 + 成本护栏 + 批量）

> 日期：2026-10-08 · 规格：设计规格 §7 通道层 / §8 工具面 / §13 测试 · 前置：[M1 验收](./2026-10-08-m1-verification.md)
> 结论：**M2 出口标准达成**。两条真实通道适配器、通道探测、成本护栏、结果缓存、批量工具全部落地，并在真机 dsh 宿主上端到端验证。

## 1. 交付内容

| 层 | 文件 | 说明 |
|---|---|---|
| 错误归一 | src/provider/errors.ts | 五类归一错误码 + Retry-After 解析 + 指数退避 + 面向用户的建议文案 |
| HTTP 底座 | src/provider/http.ts | 超时/中止、429-5xx 退避重试、JSON 容错解析、产物下载落盘、base64 落盘、容错取值 |
| 模型目录 | src/provider/catalog.ts | 12 条内置模型规格（尺寸风格 / 负向 / 参考图 / 种子 / 价目）+ 通道类型缺省 |
| 成本护栏 | src/provider/pricing.ts | 三层查价（通道覆盖 > 内置目录 > unknown）+ 阈值与未知价确认判定 |
| 同步通道 | src/provider/openai-images.ts | `POST {base}/v1/images/generations`，b64 与 url 双形态，负向折进提示词，参考图注入 |
| 异步通道 | src/provider/task-images.ts | 提交 → 轮询（in_progress→processing）→ 签名 URL 立刻下载；轮询超时记失败 |
| 结果缓存 | src/store/cache.ts | 内容哈希键 + materialize 复制到本次产物目录 + prune/clear |
| 生成编排 | src/host/generate.ts | 工具 / HTTP / 批量共用的唯一入口（通道→编译→查价→确认→缓存→生成→记账） |
| 工具 | src/tools/index.ts | 新增 `img_compose`、`img_batch`；`img_generate` 接入护栏与缓存；`img_channels` 增加 probe |
| 路由 | src/host/routes.ts | 新增 channels.probe / batch / cache.stats / cache.clear；generate 支持 confirm 与 useCache |
| 配置卡 | client.js | 「测试通道」升级为 probe（鉴权/端点风格/模型数/实跑），新增实跑开关与缓存计数 |

## 2. 离线验收

    $ npm run typecheck     # tsc strict 零错误
    $ node --test test/*.test.ts
    ℹ tests 109   ℹ pass 109   ℹ fail 0

M2 新增覆盖（62 项）：协议工具函数、同步/异步适配器全路径、错误归一与退避、
三层查价与确认判定、缓存键与命中/淘汰、缓存的坏索引容错、批量与缓存交互、
路由层的 probe/batch/confirm/cache，以及通道新字段的校验与回读。

## 3. 真机端到端实测（隔离 DSH_HOME + rescue profile）

| 探针 | 实测输出 |
|---|---|
| 插件激活 | 零警告（5 个工具全部注册成功） |
| `GET /api/state` | `channels: 2 \| cache: {entries: 2, bytes: 68738, hits: 2} \| spend entries: 2` |
| `GET /api/cache.stats` | `200 {entries:2, bytes:68738, hits:2}`（读操作允许 GET） |
| `POST /api/channels.probe`（realRun） | `auth: ok \| endpoint: sync-images \| realRun ok: true` |
| `POST /api/generate` 首次 | `kind: generated`，落盘 41216 字节 PNG |
| `POST /api/generate` 同输入 | `kind: cached`（不重复计费） |
| `POST /api/batch` 两项（一项同上） | `['cached', 'generated']` |
| 未知价通道 `POST /api/generate` | `HTTP 409 confirm-required`，且**记账条数不变（0 新增）** |
| 探测产物位置 | 落在 `<插件数据目录>/probe/`（不是进程 cwd） |
| 非回环 Host | `403 forbidden` |

## 4. 本轮抓到的三个真实缺陷（均已修复 + 回归）

### 4.1 端点拼接出 `/v1/v1/...`
用户把 Base URL 填成 `https://host/v1`（极常见）时，与缺省路径 `/v1/tasks/{id}` 拼成 `/v1/v1/tasks/...`。
单测先于真机抓到。修复：`resolveEndpoint` 对显式路径与缺省路径统一做 `/v1` 去重。

### 4.2 批量预检真的在生成（会重复烧钱）
`img_batch` 的「先确认成本」实现里，预检直接调了 `runGeneration`——对不需要确认的项，
预检阶段就把图生成了、钱也花了，正式执行再走一遍。
修复：新增 `dryRun` 阶段（只报价不生成），预检用 `dryRun: true`，工具与路由两处都改。
回归断言：未知价批量必须先 409 且**记账条数为 0**。

### 4.3 未声明模型导致「每次都要求确认」
通道没有声明 `models[]`、用户也没设默认模型时，模型名解析为空串 → 查不到价目 → 每次生成都被判为未知价。
修复：模型解析链补上按通道类型的兜底（`mock` → `mock-image-v1`），并让 mock 通道实现 `probe`，
使「测试通道」在所有通道类型下行为一致。

## 5. 关键设计取舍（记录备查）

- **负向清单不进 negative 字段**：当前主流图像 API（OpenAI 系、聚合站）都没有 `negative_prompt` 字段，
  编译器产出的负面清单以 `Strictly avoid: ...` 折进提示词末尾；仅当通道/模型声明支持（如部分 flux 端点）才走原生字段。
  模板 pitfalls 始终留在 CONSTRAINTS 段（散文不作负面词）。
- **未知价一律确认**（`confirmUnknownPrice` 默认开）：宁可多问一句，也不要静默烧钱。
- **缓存命中会复制文件到本次产物目录**：调用方拿到的路径语义与真生成一致，缓存对上层完全透明。
- **轮询超时视为失败**：不记成功、不落半成品。

## 6. 真实密钥端到端（2026-10-08 追加）

需求方提供了真实中转与密钥，因此补做了 M2 原本挂账的**真实付费实跑**。

### 6.1 端点侦察（免费）

| 探测 | 结果 |
|---|---|
| `GET /v1/models` | 200，13 个模型（gpt-5.x 文本系 + gpt-image-1 / 1.5 / 2 / 2-4k / 2.5 / 2.5-flare / 2.5-sunburst） |
| `GET /api/pricing` | 200，43 行；gpt-image-2 = quota_type 1（按次）model_price 0.75 |
| `POST /v1/chat/completions` | 400 应用层 JSON（模型不支持该端点）→ **鉴权与 POST 正常** |
| `POST /v1/images/generations` | **403 nginx HTML**（带鉴权、不带鉴权、带浏览器 UA/Referer 均如此）→ 路径被部署层挡掉 |
| `POST /v1/image/generations`、`/v1/draw/completions` | 404 应用层 JSON `Invalid URL` → 不存在 |
| `POST /v1/responses` | 200 → **图片模型的真实入口** |

### 6.2 契约钉死

    POST {base}/v1/responses
    { "model": "gpt-image-2", "input": "<prompt>",
      "tools": [{ "type": "image_generation", "size": "1024x1536", "quality": "low" }] }
    -> 200 { output: [ { type: "image_generation_call", status: "completed",
                        result: "<base64 PNG>", revised_prompt: "..." } ],
             usage: { completion_tokens_details: { image_tokens: 408 } } }

- 尺寸与质量是**工具对象的参数**，不是顶层字段（请求 1024x1536 → 返回 PNG 实测正是 1024x1536）。
- 产物是 base64（不是签名 URL），仍立刻落盘。
- 成本**按图像 token 计费**：三轮实测 2483 token = 1834 额度 ≈ 0.739 额度/token；
  按 new-api 口径 500000 额度 = 1 USD，则默认画质一张 ≈ ¥0.017、quality=low ≈ ¥0.0045。
  站点 `/api/pricing` 的 model_price 0.75 与实测口径不一致（观测 611 额度/张），
  **以余额差值为准**——设计里「计价单位口径要用余额差值钉死」这条再次应验。

### 6.3 新增第三条适配器

原 M2 的两条适配器都覆盖不到这条路径，因此新增 **openai-responses** 通道类型
（src/provider/openai-responses.ts）：

- sizeStyle 固定 pixels（尺寸在工具对象里）；
- 负向清单折进 input（无原生负向字段）；
- 参考图走 input 的 parts 形态（input_text + input_image）；
- 解析 output[].image_generation_call，失败状态抛 TASK_FAILED，无该字段抛 BAD_RESPONSE（带上游原因）；
- 额外记录 image_tokens 与 revised_prompt 供成本核算。

11 项单测覆盖请求体形态、协议解析、错误路径与探测；全量 **120 项全绿**。

### 6.4 走插件的真实端到端

| 步骤 | 实测 |
|---|---|
| 注册通道 | 回包 apiKey: sk-••••siA、hasKey: true、sizeStyle: pixels；vault -rw------- |
| channels.probe（不实跑） | ok / auth=ok / endpoint=responses-images / models=13 |
| /generate 真实出图 | HTTP 200，37.9s，1024x1536，1.62 MB，报价 exact ¥0.02（通道覆盖价） |
| 产物 | docs/evidence/m2-real-tianyuai-gpt-image-2.png |

用的是一个完整 ImagePrompt v1（cinematic 三格 + 角色表 + 中文对白 + 负面清单）。结果：

- 编译器分段全部落进真实提示词（STYLE → SUBJECT → COMPOSITION → …）；
- **中文对白「时间戳怎么全一样？」逐字正确渲染** —— 设计里列为最高风险的「中文出字」在这一档模型上成立；
- 角色表特征（齐刘海 / 圆眼镜 / 深灰卫衣）与 dramatic 冷光色调都对齐；
- 日志面板里的时间戳被画成完全相同的值，说明主体描述被准确理解。

### 6.5 密钥处置

密钥只写入插件 vault（.scratch/real-home/vault.json，0600，已 gitignore）；
提交前双向核验：**工作树与暂存区均无密钥字面量**。
另需提醒：该密钥在对话里出现过明文，建议在中转后台轮换一次。

## 7. 已知限制

- ~~真实通道只用桩 fetch 验证过协议路径；没有对真实第三方端点做过付费实跑~~ → 见 §6（已用真实密钥完成付费实跑）。
- QiLin 真机仍未启动（M1 起挂账）；双通道装配已就绪，M3 一并补。
- `img_generate` 的确认闸门目前是「工具返回确认请求 → 模型带 confirm=true 重调」，尚未接宿主原生 ask 通道。
- 参考图（图像锁）已具备注入能力但尚无调用方（M3 知识漫画接入）。
