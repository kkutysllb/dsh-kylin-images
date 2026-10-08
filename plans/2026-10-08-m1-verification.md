# M1 验收记录（宿主接入 + 视觉模型配置菜单）

> 日期：2026-10-08 · 规格：[docs/superpowers/specs/2026-10-08-dsh-kylin-images-design.md](../docs/superpowers/specs/2026-10-08-dsh-kylin-images-design.md)
> 结论：**M1 出口标准达成**，且在**真机 dsh 宿主**上完成端到端验证（不是仿真）。

## 1. 真机验证环境

隔离 profile，不污染作者日常环境：

    DSH_HOME=<workspace>/.scratch/dsh-home          # 全新隔离 home
    dsh rescue --from-default-profile web           # 从出厂 web 模板生成 rescue profile
    dsh plugin --profile rescue add <workspace>     # link: 安装本插件
    dsh --profile rescue --host 127.0.0.1 --port 45999 --no-open

profile 组合结果（`dsh --profile rescue --dump-config`）：

    # == dsh-kylin-images
    - id: dsh-kylin-images
      name: dsh-kylin-images

启动日志（修复后）：**零警告**，插件行正常激活。

## 2. 端到端实测输出

| 探针 | 结果 |
|---|---|
| `GET /dsh-kylin-images/health` | `HTTP/1.1 200 OK` |
| `GET /dsh-kylin-images/api/state` | 返回 15 个「视觉模型」字段的默认值 + 空通道表 + 空记账 |
| `POST /api/channels.upsert` | 创建 mock 通道成功；回包 `apiKey` 为空串、`hasKey:false`（脱敏出口） |
| `POST /api/channels.test` | `{ok:true, detail:'mock 通道：本地生成占位图，不发起任何网络请求', sizeStyle:'ratio-resolution'}` |
| `POST /api/generate` | 落盘 `img-1791476031500.png`，1024x1536，41217 字节，21ms；`negative` 已由编译器注入 |
| `Host: evil.example.com` 打 `/api/state` | `{"ok":false,"error":{"code":"forbidden"}}`（信任围栏生效） |
| 磁盘校验 | `file`：`PNG image data, 1024 x 1536, 8-bit/color RGB, non-interlaced` |
| 产物可被模型看到 | 见 [docs/evidence/m1-mock-output.png](../docs/evidence/m1-mock-output.png)（read_image 已确认可渲染） |
| 存储权限 | `vault.json` = `-rw-------`，插件数据目录 = `drwx------` |
| 记账 | `spend.jsonl` 追加一条 `{channelId:'mock', count:1, amount:0, durationMs:21}` |

## 3. 真机 boot 抓到的两个真实缺陷（已修复）

这两个缺陷在纯单测里**永远暴露不出来**——只有真机加载才会触发，是本轮最有价值的产出。

### 3.1 Config 必须是 Standard Schema，不是普通 JSON Schema

    dsh-kylin-images: TypeError: Cannot read properties of undefined (reading 'validate')
        at resolveConfig (cordis/lib/index.js:958)

- 根因：cordis 的 `resolveConfig` 走 Standard Schema v1，读取 `Config['~standard'].validate(raw)`；
  导出 `{type:'object', properties:{...}}` 这类普通 JSON Schema 时 `Config['~standard']` 为 undefined，
  **整条插件行激活失败**（网络与路由全部不挂载）。
- 修复：[src/host/config-schema.ts](../src/host/config-schema.ts) 手写最小 Standard Schema（零依赖，不引 schemastery），
  容错归一化 + 保留未知键 + 永不产生 issues；并新增 `apply(ctx, config)` 用宿主配置播种设置。
- 回归测试：`test/host.test.ts` 断言 `~standard.version === 1`、未知键保留、坏值回落默认。

### 3.2 工具必须声明 output 契约

    TypeError: tool "img_channels" must declare output { schema, render, presentationMeta? }

- 根因：DSH 工具注册强制要求 `output`；缺了同样会让整条插件行激活失败（不是跳过该工具）。
- 修复：[src/tools/index.ts](../src/tools/index.ts) 增加 `stringOutput(title)` 契约
  （`{schema:{type:'string'}, render:(args,value)=>[{type:'text',text:value}], presentationMeta:()=>({title})}`）。

附带修正：健康路径从 `/health` 改为插件作用域 `/dsh-kylin-images/health`——前缀路由若命中宿主的 `/health` 会劫持宿主自身的健康检查。

## 4. 离线验收命令

    $ npm run typecheck     # tsc strict，零错误
    $ npm run build         # tsc -> lib/（宿主入口）
    $ node --test test/*.test.ts
    ℹ tests 74   ℹ pass 74   ℹ fail 0
    $ npm run sync:check    # 上游数据对账通过（commit 65a9c57a1968…）

覆盖：尺寸三形态、编译分段与负面出口、双语检索与分页、P0-P10 选型、上游对账、许可署名、
vault 校验与脱敏、记账、PNG 编码、路由围栏与 405、mock 全链路、工具面、client.js 自注册与双座席。

## 5. M1 交付物

| 层 | 文件 |
|---|---|
| 宿主编排 | src/index.ts（cordis apply + 设置命名空间软探测）、src/host/config-schema.ts、src/host/registry.ts |
| HTTP | src/host/routes.ts（health + fenced JSON API：state / channels.* / settings.update / library.* / compose / generate） |
| 通道 | src/provider/{types,mock,png}.ts |
| 存储 | src/store/{home,vault,settings,spend}.ts |
| 工具 | src/tools/index.ts（img_channels / img_library / img_generate） |
| 客户端 | client.js（「视觉模型」卡片，双座席自注册，零构建产物） |
| 装配 | cordis.patch.yml（插件行已启用）、package.json（dsh + qilin 双通道，version 0.1.0） |
| 证据 | docs/evidence/m1-mock-output.png |

## 6. 已知限制（M2 起处理）

- 只有 mock 通道；openai-images（同步）与 task-images（异步）适配器 M2 交付。
- `img_compose` / `img_batch` / `img_comic` 工具未交付（M2/M3）；compose 与 generate 目前经 JSON API 暴露。
- 成本护栏只有记账与阈值字段，确认闸门（ask 通道）M2 接。
- 缓存字段已落库，缓存实现 M2。
- 客户端卡片目前只经插件自有 API 读写；宿主 configForms 的「已覆盖 / 恢复默认」语义 M2 补齐。
- QiLin 宿主本轮未真机启动（只验证了 bundle 双键与方案契约），M2 补麒麟真机一轮。
