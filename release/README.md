# 版本发布说明 / Release Notes

本目录是 dsh-kylin-images 的版本发布事实源：每个发布版本一份
`v<semver>.md`，与 git tag 一一对应。`package.json` 的 `version` 是 KCoder
插件管理检测新版本的信号——**每次发布必须 bump 版本号**；检测到新版本后由
用户手动更新。

## 版本索引

| 版本 | 日期 | 说明 |
|---|---|---|
| [v0.1.1](v0.1.1.md) | 2026-10-11 | 双形态响应兜底（文本藏 URL 不再产生孤儿产物）+ img_generate 失败改抛错（isError，不再被误判成功） |
| [v0.1.0](v0.1.0.md) | 2026-10-09 | 首个发布：Prompt-as-Code 提示词编译器 + 图像生成执行器 + 知识漫画管线，dsh / 麒麟双通道 |

## 发版约定

1. 真源仓完成开发与验证：`npm run typecheck && npm test && npm run build && npm run sync:upstream:check`；
2. bump `package.json` 的 `version`，写好 `release/vX.Y.Z.md`，提交并推送真源仓；
3. `git tag vX.Y.Z && git push origin vX.Y.Z`（tag 与说明文件一一对应）；
4. `npm run release:notes vX.Y.Z` —— 把说明同步为 GitHub Release（幂等可重跑，需 gh 登录、tag 已推送）；
5. `npm run sync:mirror` 同步分发镜像，并在 dsh-plugins 仓提交推送
   （该仓 pre-commit 硬拦「插件变更未同步 README」的提交）；
6. `npm publish` 发布到 npm registry（由维护者执行）→ npmmirror 自动同步。
