# 芯研流 · IC Research Flow

面向集成电路研究者的纯浏览器论文管理、智能检索与影响力图谱工具。它可以直接部署到 GitHub Pages：每位访问者投入自己的 PDF、填写自己的 DeepSeek 兼容接口，在自己的浏览器里建立独立论文库。

## 已实现功能

- 批量投入本地 PDF，使用 SHA-256 去重，PDF.js 按页提取文本。
- IndexedDB 持久化原始 PDF、论文元数据、结构化分析、处理任务和缓存。
- DeepSeek 连接测试与集成电路专用结构化分析提示词。
- 默认使用当前的 `deepseek-v4-flash`，也可选择 `deepseek-v4-pro`；浏览器里遗留的 `deepseek-chat` / `deepseek-reasoner` 配置会自动迁移。
- 九个 IC 一级知识域，以及对象、问题、方法、工艺节点、指标、应用、发现、局限和参考文献等研究切面。
- 中英文 IC 术语归一与 MiniSearch 本地全文索引；单次最多召回 50 篇。
- 带引用语义权重、个性化向量和时间衰减的 IC-Influence Rank。
- 相关性 40%、影响力 30%、前沿度 15%、证据 10%、桥接性 5% 的透明评分。
- MMR 多样性筛选，输出最多 15 篇核心论文。
- 内容知识树、影响力网络、核心论文卡片和证据页侧栏。
- 可恢复的处理状态、单篇失败隔离和浏览器内 PDF 打开。

## 隐私与版权边界

原始 PDF 不会上传到 GitHub 或本站服务器，而是保存在访问者当前浏览器的 IndexedDB 中。为完成 AI 分类，网站会把从 PDF 中选取的文本片段发送到访问者填写的 DeepSeek 兼容接口。API Key 默认只保存在当前标签会话；只有访问者主动勾选后才写入该浏览器的本地存储。

清除该网站的浏览器站点数据会删除本地论文库。共享设备上不建议持久化 API Key。静态网页直接请求 API，因此自定义接口必须允许该 GitHub Pages 域名进行 CORS 请求。

## DeepSeek 连接

- 官方 API 地址填写 `https://api.deepseek.com`；也兼容带 `/v1` 的地址或完整的 `/chat/completions` 地址。
- 远程接口必须使用 HTTPS；为兼容本机模型服务，`localhost` 和 `127.0.0.1` 可使用 HTTP。空地址、相对路径和不安全协议会在发送密钥前被拒绝。
- 推荐模型为 `deepseek-v4-flash`，需要更强模型时可改为 `deepseek-v4-pro`。
- “测试连接”只发送一条极短测试消息，不会上传论文。
- 页面会区分密钥错误、余额不足、模型或地址错误、限流和网络/CORS 错误。复制密钥时首尾多出的空格会自动清理。

## 本地运行

```bash
pnpm install
pnpm dev
```

质量检查：

```bash
pnpm run test:run
pnpm run typecheck
pnpm run build
```

## 发布到 GitHub Pages

1. 将本项目推送到 GitHub 仓库的 `main` 分支。
2. 在仓库 **Settings → Pages → Build and deployment** 中选择 **GitHub Actions**。
3. 推送后，`.github/workflows/deploy-pages.yml` 会自动测试、构建并发布 `dist`。

Vite 使用相对 `base: './'`，路由使用 `HashRouter`，因此既支持项目子路径 Pages，也不依赖服务器回退规则。

## 技术栈

React 19、TypeScript、Vite、Dexie、PDF.js、MiniSearch、D3、Vitest、GitHub Actions Pages。
