# 第三方声明 / Third-Party Notices

本插件（dsh-kylin-images）包含或改编自以下第三方作品。分发本插件时必须一并保留本文件。

## 1. awesome-gpt-image-2（知识数据与技能，MIT）

- 来源：https://github.com/freestylefly/awesome-gpt-image-2
- 快照 commit：65a9c57a1968a13f2f1997c58409cac9aa146bc7（2026-10-03）
- 许可：MIT，Copyright (c) 2026 freestylefly
- 引入内容：
  - data/style-library.json（原文复制）
  - data/cases.json（原文复制）
  - agents/skills/gpt-image-2-style-library/（改编为插件内 skills/gpt-image-2-style-library）
- 改动说明：
  - 数据文件原样 vendored，不做字段改写；插件只读取，不写回。
  - 技能正文按 DSH/QiLin 的 runtime skill 契约改写（剥离 frontmatter、资源目录化、路径改为工作区相对），
    流程与判断逻辑保持与上游一致；生成动作改由本插件的 img_* 工具承担。
  - 上游图片资产（data/images，573 文件 / 约 158 MB）**未随包分发**，仅在 UI 中以远端 URL 按需引用。
- 对账：data/upstream.lock.json 记录内容哈希；npm run sync:check 断言未被静默改动。

## 2. KSkills media/comic 与 media/image-generation（适配）

- 来源：本地/内部 KSkills 技能仓（knowledge comic v1.1.0，image-generation）
- 引入内容：知识漫画工作流（内容分析 → 角色设定 → 分镜 → 逐页提示词 → 生成 → 组装）与风格/色调/布局选型表。
- 改动说明：
  - 原技能依赖宿主的 /mnt/skills 与 /mnt/user-data 路径、Python + requests + PIL 运行时；
    本插件改为工作区相对路径与零依赖 Node 运行时，并补齐原脚本缺失的 negative_prompt、
    超时/退避、并发与断点续跑、成本护栏、组装等能力（见设计规格 §9.5）。
  - 原技能的 P0-P10 选型表实现为可单测的纯函数 src/comic/select.ts。
- 备注：KSkills 仓内暂无 LICENSE 文件，建议补齐；本插件在此按来源署名。

---

## 附：awesome-gpt-image-2 的 MIT 许可全文

```text
MIT License

Copyright (c) 2026 freestylefly

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
