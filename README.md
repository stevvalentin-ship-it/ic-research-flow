# 芯研流 · IC Research Flow

> 一个“把 PDF 当论文读，把 DeepSeek 当牛马用”的纯浏览器科研小站。

## 这是什么？

面向集成电路研究者的论文管理、智能检索与影响力图谱工具。

它可以直接部署到 GitHub Pages：每位访问者投入自己的 PDF，填写自己的 DeepSeek 兼容接口，在自己的浏览器里建立独立论文库。

**简单说：你的论文不用上传，AI 帮你干活，GitHub 只负责看热闹。**

## 已实现功能

- 批量投入本地 PDF，使用 SHA-256 去重，PDF.js 按页提取文本。
- IndexedDB 持久化原始 PDF、论文元数据、结构化分析、处理任务和缓存。
- DeepSeek 连接测试与集成电路专用结构化分析提示词。
- 默认支持图片的 `deepseek-v4-flash-vision-exp`，也可以切回 `deepseek-v4-flash` / `deepseek-v4-pro`。
- 动态主题分类：不搞死板的九大类，根据论文内容“现场总结”侧重点。
- 论文相关性网络：不是引用关系，是“这俩论文看起来有暧昧”的关系。
- PageRank 评分：如果它某天不抽风的话，还是挺高级的。
- 中英文 IC 术语归一与 MiniSearch 本地全文索引。
- MMR 多样性筛选，输出 12–15 篇核心论文。
- 内容知识树、影响力网络、核心论文卡片和证据页侧栏。
- 失败自动重试 + 论文库手动重试按钮，AI 拉胯时我们负责捞。

## 隐私与版权边界

- 原始 PDF **不上传 GitHub、不上传本站服务器**，只保存在当前浏览器的 IndexedDB。
- 只有分析所需的文本片段或页面图片会发送到你配置的 DeepSeek 接口。
- API Key 默认只保存在当前标签会话；只有你主动勾选后才写入 localStorage。
- 共享设备上不建议持久化 API Key。
- 清除网站数据 = 本地论文库和你 say goodbye。

> 密钥就像内裤：不能随便给人看，更不能提交到仓库。

## DeepSeek 连接

- 官方地址：`https://api.deepseek.com`
- 也兼容带 `/v1` 或完整 `/chat/completions` 的地址。
- 远程接口必须是 HTTPS；`localhost` / `127.0.0.1` 允许 HTTP。
- 本地开发通过 Vite 同源代理转发，避免部分浏览器拦截。
- GitHub Pages 静态版由访问者浏览器直连接口，接口需要允许 CORS。

## 本地运行

```bash
pnpm install
pnpm dev
```

如果你用 `npm` 凑合也可以，就是跑起来偶尔像老奶奶过马路。

## 发布到 GitHub Pages

1. 推送到 GitHub 仓库的 `main` 分支。
2. 在仓库 Settings → Pages 中选择 GitHub Actions。
3. 推送后 `.github/workflows/deploy-pages.yml` 会自动测试、构建并发布 `dist`。

## 技术栈

React + TypeScript + Vite + PDF.js + Dexie + MiniSearch + D3 + DeepSeek

简单说就是：一堆前端库手拉手，试图理解你硬盘里的论文。

## 免责声明

- 不提供论文下载，不提供 OCR 魔法，不负责帮你写论文。
- 扫描版/图片型 PDF 会尽量让 DeepSeek 看一眼；它看懂了是缘分，没看懂是 AI 的问题。
- 评分、分类、连线都是“尽力而为”，请把它们当参考，不要当真理。

---

祝你的论文早日变成知识树，而不是永远躺在“处理中”。
