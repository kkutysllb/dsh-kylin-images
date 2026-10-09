# 安装与验证清单（dsh + 麒麟桌面端）

> 这份清单给**人工在本机执行**的最终验证用。开发期的隔离验证记录在 plans/ 下各里程碑文档里，
> 但**真机装到你自己日常使用的 dsh 与麒麟桌面端**这一步没有代跑过——需要你按下面执行并确认。

## 0. 前置

- Node >= 24（插件零运行时依赖，只用 node: 内置模块）
- DSH CLI（本机 /opt/homebrew/bin/dsh，实测版本 0.2.1-alpha.1）
- 麒麟桌面端（QiLin / Kylin）
- 一个可用图像通道。本机已验证的示例：`https://tianyuai.lol`，模型 `gpt-image-2`，
  通道类型必须是 **openai-responses**——该部署把 `/v1/images/generations` 在 nginx 层 403 掉了。

## 1. 先跑离线自检（不装、零成本）

    cd /path/to/dsh-kylin-images
    npm install
    npm run typecheck     # 期望：无输出（无类型错误）
    npm test              # 期望：tests 151 / pass 151 / fail 0
    npm run sync:check    # 期望：上游对账通过 commit 65a9c57a1968
    npm run build         # 期望：生成 lib/

## 2. 装到 dsh

先隔离试装（不动你现有环境）：

    DSH_HOME=/tmp/dsh-kimg dsh rescue --from-default-profile web
    DSH_HOME=/tmp/dsh-kimg dsh plugin --profile rescue add /path/to/dsh-kylin-images
    DSH_HOME=/tmp/dsh-kimg dsh --profile rescue --port 45999 --no-open

确认没问题后装到常用 profile：

    dsh plugin --profile web add /path/to/dsh-kylin-images

**验收点 1**：启动日志里**不应出现** did not activate 之类的告警。
（历史教训：Config 不是 Standard Schema、工具缺 output 契约，都会让整条插件行静默不激活。）

**验收点 2**：以下接口返回 200：

    curl -sS http://127.0.0.1:<port>/dsh-kylin-images/health
    curl -sS http://127.0.0.1:<port>/dsh-kylin-images/api/state

**验收点 3**：插件详情页出现「视觉模型」配置卡（plugins.bundle.config 座席），
另有设置页导航「视觉模型」兜底项（settings.section）。卡片能列通道、保存后回显脱敏串。

**验收点 3b**：配置卡的「类型」下拉里**必须能选到 openai-responses**（4 个类型齐全，且各带一句说明）。
历史缺陷：下拉曾漏掉 openai-responses，导致只能选同步出图，而站点恰好只放行 Responses 路径——
真机上一出图就是 403 HTML。测试已按服务端 CHANNEL_KINDS 对账防漂移。

## 3. 配置真实通道

在「视觉模型」卡片里新增通道：

| 字段 | 值 |
|---|---|
| 名称 | 天语中转（随意） |
| 类型 | openai-responses |
| Base URL | https://tianyuai.lol |
| API Key | 你的密钥（保存后只显示 sk-••••xxx，明文只进本机 vault） |
| 模型 | gpt-image-2（也可加 gpt-image-2.5） |
| 尺寸风格 | pixels |
| 超时 | 300000（该站单张约 30s，带参考图可达 40s+） |
| 价目覆盖 | 建议 default: 0.02（实测约 ¥0.017/张默认画质） |

**验收点 4**：「测试通道」期望 auth=ok、端点=responses-images、模型 13 个。
不勾「小额实跑」时**不产生任何费用**。

**验收点 4b（端点可达性）**：探测结果里会多出两行「端点可达性」证据，例如：

    端点可达性（零成本探测：哨兵模型，必然失败，不会出图）
    - /v1/images/generations：gateway-blocked（HTTP 403，被前置代理拦截（返回 HTML，未到 API 层））
    - /v1/responses：routed（HTTP 503，路由可达（返回 JSON））
    证据可用的端点风格：responses-images

这两行来自一次**零成本**探测：以不存在的哨兵模型发必然失败的请求，只判「请求有没有到达 API 层」，
不可能出图、不产生费用。要把类型选成 openai-responses 时，这里会直接给出建议。
只看 /v1/models 会给假绿灯（该端点甚至不校验 token），这是真机上踩过的坑。

## 4. 最小出图验证

在会话里说：**用默认通道画一张竖版 3:4 的信息图：……，先给我看提示词再出图**

期望：模型先调 img_compose（零成本预览），确认后调 img_generate 出图，并把落盘路径回给你。

**验收点 5**：产物文件存在、file 显示 PNG image data / 1024 x 1536、成本显示 exact 或 estimated。

## 5. 知识漫画全流程验证

在会话里说：**把下面的内容做成 3 页知识漫画：……**（贴一段 200 字以上的内容）

期望的工具调用序列：img_comic open -> plan -> sheet -> render -> assemble。

**验收点 6**：img_comic status id=<项目> 显示 3/3 页已出图、图像锁 开；
侧边栏「图像工坊」能看到该项目、展开有缩略图、能打开联系表。

**验收点 7（关键）**：跨页角色形象一致；中文对白逐字正确（不是乱码或错字）。

成本参考：3 页 + 三视图 约 ¥0.08。

## 6. 装到麒麟桌面端

麒麟的插件管理器只认原生键 qilin.bundle.patch（本插件已声明）。安装：

    # 先确认你的 QILIN_HOME（默认 ~/.qilin；桌面端也可能用 ~/.kcoder 等自定义值）
    echo "QILIN_HOME=$QILIN_HOME"

    qilin plugin --profile qilin add /path/to/dsh-kylin-images
    # 若桌面端使用自定义 home：
    # QILIN_HOME=<你的路径> qilin plugin --profile qilin add /path/to/dsh-kylin-images

装完重启 / 重载桌面端。

**验收点 8**：插件管理页不报「没有声明组合包」；插件能启用。

**验收点 9**：插件详情页的「视觉模型」卡片正常渲染。麒麟 3.x 走 settings.installSection
注册的设置命名空间 + plugins.bundle.config 座席；卡片自带 --dsw-alias-* 令牌样式，
观感应与宿主设置页一致。

**验收点 10**：会话里 img_channels action=list、img_library query=教程、img_comic action=status
三个工具都能返回内容（说明工具面在麒麟上同样注册成功）。

**验收点 11**：技能目录里能看到 knowledge-comic / gpt-image-2-style-library / image-prompt-protocol
三个 runtime 技能（若宿主提供技能列表 UI）；否则至少确认插件激活无 warn。

## 7. 出问题时怎么定位

| 现象 | 先看什么 |
|---|---|
| 插件整块消失、无报错 | 启动日志有没有 did not activate；对照 M1 验收记录里的两个激活期陷阱 |
| 麒麟报「没有声明组合包」 | package.json 的 qilin.bundle.patch 是否被安装包带上（files 白名单） |
| 配置卡空白 | 浏览器控制台；缺 slots / configForms 服务时会软跳过并打 [dsh-kylin-images] 前缀的 warn |
| 出图报 ENDPOINT_BLOCKED / 403 HTML | 端点把 images 路径挡了（前置代理返回 HTML 而非 API JSON）。这是**配置问题不是 Key 问题**：把通道类型改成 openai-responses。用 img_channels action=probe 看零成本端点探测给出的建议 |
| 出图 401 / 402 | 密钥或余额；img_channels action=test 看具体错误码与建议 |
| 批量被要求确认 | 成本护栏生效（未知价或超 ¥1 阈值），带 confirm=true 重调即可 |
| 漫画报「尚未配置通道」 | 默认通道没设；在「视觉模型」里选一个默认通道 |

## 8. 卸载与数据

    dsh plugin --profile web remove dsh-kylin-images
    qilin plugin --profile qilin remove dsh-kylin-images

插件数据（vault / 产物 / 缓存）在 <DSH_HOME 或 QILIN_HOME>/.dsh-kylin-images/，
漫画项目在该目录的 comics/ 下。确认不需要后手动删除即可。
**注意：vault 里存着你的 API Key（文件权限 0600）。**
