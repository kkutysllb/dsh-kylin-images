# M3/M4 验收记录（知识漫画管线 + 图像工坊）

> 日期：2026-10-08 · 规格：设计规格 §9 知识漫画管线 / §10 技能面 / §11 客户端
> 结论：**M3 出口标准达成**（真机 3 页漫画端到端）；**M4 主体达成**（侧边栏图像工坊 + 产物路由 + 联系表）；
> 可选 PDF 以「HTML 打印为 PDF」替代，取舍见 §6。

## 1. 交付内容

| 层 | 文件 | 说明 |
|---|---|---|
| 项目状态机 | src/comic/project.ts | slug、目录约定、comic.json 原子落盘、冲突追加时间戳、项目列举 |
| 分镜编译器 | src/comic/plan.ts | storyboard/characters 校验 + 每页 ImagePrompt v1 编译 + 风格锁前言 |
| 组装 | src/comic/assemble.ts | 零依赖联系表 HTML（转义、未出图占位、打印样式） |
| 服务编排 | src/comic/service.ts | open / plan / sheet / render / status / assemble 六个动作 |
| 工具 | src/tools/index.ts | 新增 img_comic（第 6 个工具） |
| 路由 | src/host/routes.ts | comic.action / comic.list / comic.status / artifact（产物受控读取） |
| 技能 | skills/ 下三个 SKILL.md | 随包 runtime skill，激活即注册（软探测 skills 服务） |
| 客户端 | client.js | 侧边栏「图像工坊」：项目列表 + 逐页缩略图 + 打开联系表 |

## 2. 三锁机制的落地位置

| 锁 | 实现 | 可测锚点 |
|---|---|---|
| 文字锁 | plan.ts 把角色表逐字注入每页 ImagePrompt | 单测断言只注入本页列出的角色 |
| 风格锁 | 项目级 artStyle/tone/layout/宽高比 + 全篇同一句 must 前言 | 单测断言三页前言集合大小为 1 |
| 图像锁 | sheet 动作生成角色三视图，render 时作 referenceImages 注入 | 真机实测 render 报「图像锁 开」且中转接受参考图 |

## 3. 离线验收

    $ npm run typecheck     # tsc strict 零错误
    $ node --test test/*.test.ts
    tests 134   pass 134   fail 0

M3/M4 新增：comic 单测 9 项（含 mock 全流程 open -> plan -> sheet -> render -> assemble）、
产物路由与穿越防护 3 项、客户端第三座席 1 项。

## 4. 真机端到端（真实中转，付费）

项目：**图灵的密码战争**（3 页 + 角色三视图，共 4 张图，实付 ¥0.08）

| 步骤 | 实测 |
|---|---|
| open | 自动选型命中 P2-computing -> ligne-claire / neutral / dense / 3:4 |
| plan | 2 个角色、3 页分镜落盘，每页编译出 ImagePrompt（characters / text / must 前言齐全） |
| sheet | 角色三视图 1536x1024，中英标签逐字正确 |
| render | 3/3 页出图，55.8s，图像锁开（参考图被中转接受） |
| assemble | contact-sheet.html 生成，stage=assembled |
| 产物路由 | PNG 200 image/png 2.0MB；HTML 200 text/html；穿越 400；缺失 404 |

证据：docs/evidence/m3-real-character-sheet.png · m3-real-page-02.png ·
m3-real-contact-sheet.html · m3-real-page-02-prompt.json

第 2 页「天气报文的破绽」的成品同时验证了三件事：三段分镜全部落实、角色形象与三视图一致、
中文对白「每天早上的开头，都是一样的！」逐字渲染，且报文前缀被画成完全相同的串（剧情点本身）。

## 5. 本轮抓到并修复的真实缺陷

**宿主配置每次启动都把 vault 覆盖回默认值。** cordis.patch.yml 里的默认字段会在每次激活时
经 seedSettingsFromHost 覆盖用户的选择，导致默认通道被重置为空、img_comic 直接报「尚未配置通道」。
修复：只在 vault 首次创建时播种（Vault.exists() 判定），此后以 vault 为准。回归：新增 exists() 单测。

## 6. 关键取舍

- **不做二进制 PDF**：PDF 嵌图需要完整 PNG 解码器（隔行/调色板/16 位/滤波反演）再重新 Flate 编码，
  为一个可选交付物引入这一大块风险不划算。改为 HTML 联系表 + 打印样式，
  浏览器「打印为 PDF」结果等价。设计规格 §15 的开放问题 2 据此关闭。
- **不列角色就不注入**：早期实现是「未列出则注入全部」，会把整个卡司硬塞进每一格；
  改为只注入本页显式列出的角色，跨页一致由图像锁 + 逐字一致的描述保证。
  分镜若引用未登记角色名，plan 直接报错（否则文字锁会静默失效）。
- **产物路由必须做路径包含校验**：resolve 归一后仍须以插件数据目录为前缀，穿越一律 400（已单测）。

## 7. 已知限制

- QiLin 真机仍未启动：需求方将自行安装验证，清单见 docs/install-and-verify.md。
- 联系表内图片是相对路径：在侧边栏/浏览器里必须经产物路由打开（工作台已按此实现）。
- 漫画单篇上限 40 页、主要角色上限 8 个（护栏，非技术上限）。
