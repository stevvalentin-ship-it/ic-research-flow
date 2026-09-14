# 芯研流 · 浏览器版

纯静态 PDF 双语精读与科研工作台，部署于 GitHub Pages。打开网站即可使用，不需要本机 Python 服务。

网站：https://stevvalentin-ship-it.github.io/ic-research-flow/

## 功能

- PDF.js 在浏览器内解析 PDF，SHA-256 去重，原件保存在 IndexedDB。
- 原文阅读、划词、框选、手写圈画、个人笔记，以及本地 MathJax 公式预览。
- 明确授权后直连用户配置的模型接口，支持选文解释、普通对话与带来源的论文问答。
- 分段翻译缓存、人工校对、中文 PDF 重排与段落定位。缺失段落不会冒充完整译文。
- 本地全文检索、字段与评分权重、PageRank、参考文献候选、人工确认与排除。
- 导出原件、高亮/圈画 PDF、Markdown 笔记和项目 ZIP；支持导入 Python 3.1 版项目备份。

## 数据与使用边界

论文和笔记只保存在当前浏览器，不上传到 GitHub。不同设备、浏览器、域名之间不会自动同步；清除站点数据会删除论文库，请定期导出项目 ZIP。

API Key 默认只保存到标签页会话；只有主动勾选才持久保存。密钥不进入项目包、任务记录或译文缓存。模型接口必须使用 HTTPS 并允许网站域名的跨域（CORS）请求。本站没有模型代理，也不会自动换模型或重试收费请求。

关闭页面会中断正在处理的任务；已保存的译文缓存可以继续使用。复杂双栏、公式与图注需要在版式检查中核对。扫描件需先用 OCR 工具生成文字层再导入，或手工补充准确正文。

译文 PDF 使用中文嵌入字体，并保留原页或选区核对图。高亮/圈画 PDF 只包含图形标记；文字批注、AI 解释及 LaTeX 请导出 Markdown 或项目 ZIP。加密 PDF 的密码只在页面内存中保留。

从 Python 版迁移时，在旧站点导出每篇论文的项目 ZIP，再在本站导入。旧版项目的现成译文 PDF 可以恢复显示；没有段落映射时，可用缓存重新排版生成映射。失效历史译文不会阻止原件和笔记恢复。

## 开发与部署

```sh
pnpm install --frozen-lockfile
pnpm dev
pnpm build
```

构建产物在 `dist/`。静态部署使用相对资源路径和 Hash 路由，可部署在 GitHub Pages 项目子目录。推送 `main` 后，已有 GitHub Actions 工作流自动构建和发布。

`browser/` 是当前网页代码；`src/` 保留早期 React 版代码与测试，当前入口不加载它。`scripts/copy-pdf-assets.mjs` 从锁定的 PDF.js 依赖复制字体映射、标准字体和 WASM 资源。MathJax 和 Noto CJK 字体随站点提供，各自许可证位于 `public/vendor/` 和 `public/fonts/`。
