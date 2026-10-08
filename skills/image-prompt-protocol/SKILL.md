---
name: image-prompt-protocol
description: dsh-kylin-images 的图像提示词协议与工具分工——何时用 img_compose / img_generate / img_batch / img_comic，ImagePrompt v1 各字段怎么写，成本与缓存如何生效。
---

# 图像提示词协议（ImagePrompt v1）

本插件的唯一提示词契约。上游样式库模板、知识漫画分镜、用户自然语言，最终都收敛到这里。

## 工具分工

| 场景 | 用哪个 | 说明 |
|---|---|---|
| 想知道该用什么风格/模板 | `img_library` | 检索样式库与案例 |
| 想先看最终提示词长什么样 | `img_compose` | **零成本**，只编译不生成，可校验字段 |
| 出一张或几张变体 | `img_generate` | 编译 → 成本护栏 → 缓存 → 生成 → 落盘 |
| 一次要出很多张（页/变体） | `img_batch` | 受限并发、逐项记账、失败不拖垮整批 |
| 多页叙事 + 角色一致性 | `img_comic` | 项目制全流程（见 knowledge-comic 技能） |
| 通道配置/连通性 | `img_channels` | 总览 / test / probe（可选小额实跑） |

## 契约

```json
{
  "schemaVersion": 1,
  "id": "可选标识",
  "intent": "single-image | comic-page | variant-set | edit",
  "templateId": "样式库模板 id（可选，会自动并入该模板的避坑指南）",
  "subject": "必填：主体与要发生的事（一句话说清）",
  "composition": { "layout": "标准|电影|密集|冲击|混合|条漫|四格",
                   "shot": "景别与机位", "panels": ["每格一句话"], "hierarchy": ["视觉层级"] },
  "style": { "artStyle": "ligne-claire|manga|realistic|ink-brush|chalk",
             "tone": "neutral|warm|dramatic|romantic|energetic|vintage|action",
             "tags": ["上游风格标签"], "materials": ["材质/笔触"] },
  "text": [ { "content": "画面内文字（逐字渲染）", "kind": "speech-bubble|narration|label",
              "speaker": "谁说的", "mustRenderExactly": true } ],
  "characters": [ { "name": "名字", "sheet": "外观描述（跨页一致性靠它）" } ],
  "technical": { "aspectRatio": "3:4", "resolution": "1k|2k|4k", "format": "png|jpeg|webp", "seed": 123 },
  "constraints": { "must": ["硬要求"], "avoid": ["负面词条"] },
  "language": "zh"
}
```

简写：`{ "text": "自然语言" }` 等价于 subject。

## 编译器会做什么（确定性，可预览）

1. 固定顺序拼接：STYLE → SUBJECT → COMPOSITION → CHARACTERS → TEXT → TECHNICAL → CONSTRAINTS；
2. constraints.avoid + 全局负面词 + 通用负面词 → 负面清单；
   **模板 pitfalls 是散文，进 CONSTRAINTS 段，不进负面清单**；
3. 尺寸按通道 sizeStyle 落地：pixels（1024x1536）/ ratio-resolution（1:1 + 1k）/ ignore；
4. 当前主流图像 API 没有原生 negative 字段，负面清单会以 Strictly avoid: ... 折进提示词。

## 成本与缓存

- 查价三层：通道覆盖 > 内置目录 > 未知；**未知价一律先确认**；超过阈值（默认 ¥1）先确认。
- 确认方式：工具返回确认请求，你带 confirm=true 重调。
- 缓存键 = 通道 × 模型 × 提示词 × 负面 × 尺寸 × 分辨率 × 张数 × 种子；
  同输入第二次调用**不花钱**，漫画重渲染只补失败页。要强制重跑传 useCache=false。

## 纪律

- 生成前如不确定，先 img_compose 预览——它不花钱。
- 不要自己拼通道请求（HTTP/端点/鉴权都由插件管）。
- 产物是本地文件；用 read_image 看过再交付。
