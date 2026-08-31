# 芯研流 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建并验证一个可部署到 GitHub Pages 的纯浏览器集成电路论文管理、检索和影响力图谱网站。

**Architecture:** React/Vite 单页应用使用 HashRouter；PDF.js、Dexie、MiniSearch 和 D3 分别负责浏览器端解析、持久化、检索与图谱。DeepSeek 适配器直接调用用户配置的 OpenAI 兼容接口，所有论文与分析结果保留在访问者的 IndexedDB。

**Tech Stack:** React 19、TypeScript、Vite、Vitest、Testing Library、Dexie、fake-indexeddb、pdfjs-dist、MiniSearch、D3、Lucide React、GitHub Actions Pages。

**Spec:** `docs/superpowers/specs/2026-08-31-ic-research-flow-design.md`

## Global Constraints

- 网站必须是无需服务端的 GitHub Pages 静态单页应用，并使用 HashRouter。
- PDF 不上传到 GitHub 或本站服务器；只有分析文本发往用户配置的 DeepSeek 接口。
- API Key 默认只进入 `sessionStorage`，用户明确选择后才进入 `localStorage`。
- 检索最多召回 50 篇，最终输出 12–15 篇核心论文。
- 一级知识域严格使用规格中的九个集成电路知识域。
- 视觉严格使用 `#071A34`、`#176FE7`、`#F3F7FC`、`#DBE5F0`、`#0B1D35` 五个主色令牌。
- 新增业务函数必须先有失败测试，再写最小实现。

---

### Task 1: 静态应用骨架与科研视觉令牌

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vite.config.ts`
- Create: `index.html`
- Create: `src/main.tsx`
- Create: `src/app/App.tsx`
- Create: `src/app/App.test.tsx`
- Create: `src/styles/tokens.css`
- Create: `src/styles/app.css`
- Create: `src/test/setup.ts`

**Interfaces:**
- Produces: `App(): JSX.Element` and shared CSS tokens used by every later UI task.

- [ ] **Step 1: Create package and test configuration**

Use scripts `dev`, `build`, `test`, `test:run`, `typecheck`, and install React, Vite, Vitest, Testing Library, jsdom, Dexie, fake-indexeddb, MiniSearch, pdfjs-dist, d3, lucide-react and React Router.

- [ ] **Step 2: Write the failing shell test**

```tsx
it('shows the local-first research workbench entry points', () => {
  render(<App />)
  expect(screen.getByText('芯研流')).toBeInTheDocument()
  expect(screen.getByText('投入集成电路论文')).toBeInTheDocument()
  expect(screen.getByText('连接 DeepSeek')).toBeInTheDocument()
})
```

- [ ] **Step 3: Run the test and confirm RED**

Run: `npm run test:run -- src/app/App.test.tsx`
Expected: FAIL because `App` and the entry surfaces do not exist.

- [ ] **Step 4: Implement the smallest themed shell**

Create `App` with the dark navy header, hero copy, upload panel, API panel and the five exact color variables from Global Constraints. Use semantic `header`, `main`, `section`, `label`, `button` elements and visible focus styles.

- [ ] **Step 5: Verify GREEN and build**

Run: `npm run test:run -- src/app/App.test.tsx && npm run typecheck && npm run build`
Expected: one passing test, TypeScript exit 0, Vite build exit 0.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json tsconfig.json vite.config.ts index.html src
git commit -m "feat: scaffold IC research workbench"
```

### Task 2: 领域模型和 IndexedDB 本地仓库

**Files:**
- Create: `src/domain/types.ts`
- Create: `src/storage/database.ts`
- Create: `src/storage/paperRepository.ts`
- Create: `src/storage/paperRepository.test.ts`
- Create: `src/storage/settingsStore.ts`
- Create: `src/storage/settingsStore.test.ts`

**Interfaces:**
- Produces: `PaperRecord`, `PaperAnalysis`, `ProcessingJob`, `ResearchResult`, `paperRepository`, `loadApiSettings()`, `saveApiSettings(settings, persistKey)`.

- [ ] **Step 1: Write failing repository tests**

```ts
it('deduplicates papers by SHA-256 id', async () => {
  await paperRepository.put(makePaper({ id: 'same' }))
  await paperRepository.put(makePaper({ id: 'same', fileName: 'renamed.pdf' }))
  expect(await paperRepository.count()).toBe(1)
  expect((await paperRepository.get('same'))?.fileName).toBe('renamed.pdf')
})

it('keeps an API key in session storage unless persistence is explicit', () => {
  saveApiSettings({ baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat', apiKey: 'sk-test' }, false)
  expect(sessionStorage.getItem('icrf.apiKey')).toBe('sk-test')
  expect(localStorage.getItem('icrf.apiKey')).toBeNull()
})
```

- [ ] **Step 2: Run tests and confirm RED**

Run: `npm run test:run -- src/storage`
Expected: FAIL because repository and settings modules are missing.

- [ ] **Step 3: Implement typed Dexie schema and settings policy**

Define tables `papers`, `analyses`, `jobs`, `queryCache`; expose methods `put`, `get`, `list`, `remove`, `count`, `updateStatus`. Keep the API key outside Dexie.

- [ ] **Step 4: Verify GREEN**

Run: `npm run test:run -- src/storage`
Expected: all storage tests pass with fake-indexeddb.

- [ ] **Step 5: Commit**

```bash
git add src/domain src/storage
git commit -m "feat: add browser-local paper storage"
```

### Task 3: DeepSeek 客户端与结构化分析解析器

**Files:**
- Create: `src/api/deepseekClient.ts`
- Create: `src/api/deepseekClient.test.ts`
- Create: `src/api/analysisSchema.ts`
- Create: `src/api/analysisSchema.test.ts`
- Create: `src/api/prompts.ts`

**Interfaces:**
- Consumes: API settings and `PaperRecord`.
- Produces: `testConnection(settings): Promise<ConnectionResult>`, `analyzePaper(input, settings): Promise<PaperAnalysis>`, `expandQuery(query, settings): Promise<QueryExpansion>`, `rerankCandidates(query, candidates, settings): Promise<RerankScore[]>`.

- [ ] **Step 1: Write failing JSON extraction tests**

```ts
it.each([
  ['{"summary":"ok"}', 'ok'],
  ['```json\n{"summary":"fenced"}\n```', 'fenced'],
  ['分析如下：\n{"summary":"prefixed"}', 'prefixed'],
])('extracts structured JSON from %s', (raw, summary) => {
  expect(extractJsonObject(raw).summary).toBe(summary)
})
```

- [ ] **Step 2: Write failing client boundary test**

Stub `fetch` with a complete OpenAI-compatible response and assert the client sends `Authorization: Bearer sk-test`, `model`, JSON content type and `/chat/completions` exactly once.

- [ ] **Step 3: Run tests and confirm RED**

Run: `npm run test:run -- src/api`
Expected: FAIL because parser and client do not exist.

- [ ] **Step 4: Implement parser, prompts and client**

Use an injected `fetchImpl` for tests. Map HTTP 401, 429, network failure, invalid JSON and unknown model errors to stable error codes. Validate all nine knowledge domains and filter domain confidence below 0.55.

- [ ] **Step 5: Verify GREEN**

Run: `npm run test:run -- src/api`
Expected: all API and schema tests pass without real network calls.

- [ ] **Step 6: Commit**

```bash
git add src/api
git commit -m "feat: integrate DeepSeek-compatible analysis"
```

### Task 4: PDF 解析、去重和可恢复任务队列

**Files:**
- Create: `src/ingestion/fileFingerprint.ts`
- Create: `src/ingestion/fileFingerprint.test.ts`
- Create: `src/ingestion/pdfParser.ts`
- Create: `src/ingestion/pdfParser.test.ts`
- Create: `src/ingestion/analysisPacket.ts`
- Create: `src/ingestion/analysisPacket.test.ts`
- Create: `src/ingestion/jobState.ts`
- Create: `src/ingestion/jobState.test.ts`
- Create: `src/ingestion/processingQueue.ts`

**Interfaces:**
- Produces: `fingerprintFile(file)`, `parsePdf(file)`, `buildAnalysisPacket(parsed)`, `transitionJob(job, event)`, `ProcessingQueue`.

- [ ] **Step 1: Write failing state transition and packet tests**

```ts
it('returns an interrupted job to paused after reload', () => {
  expect(recoverJob(makeJob({ stage: 'analyzing' })).stage).toBe('paused')
})

it('keeps introduction, methods, experiments, conclusion and references within the character budget', () => {
  const packet = buildAnalysisPacket(makeParsedPaper(), 48_000)
  expect(packet.length).toBeLessThanOrEqual(48_000)
  expect(packet).toContain('REFERENCES')
})
```

- [ ] **Step 2: Run tests and confirm RED**

Run: `npm run test:run -- src/ingestion`
Expected: FAIL because ingestion functions are missing.

- [ ] **Step 3: Implement minimal PDF and queue pipeline**

Configure `pdfjs-dist` worker URL through Vite. Preserve page text, metadata and page count. Reject files with zero meaningful text using error code `SCANNED_PDF`. Process jobs sequentially and persist every state transition before calling the next stage.

- [ ] **Step 4: Verify GREEN**

Run: `npm run test:run -- src/ingestion`
Expected: all pure ingestion tests pass; PDF parser test uses a small generated fixture.

- [ ] **Step 5: Commit**

```bash
git add src/ingestion src/test/fixtures
git commit -m "feat: add resumable PDF processing queue"
```

### Task 5: 集成电路术语索引与最多 50 篇召回

**Files:**
- Create: `src/search/icTaxonomy.ts`
- Create: `src/search/tokenize.ts`
- Create: `src/search/tokenize.test.ts`
- Create: `src/search/localSearch.ts`
- Create: `src/search/localSearch.test.ts`
- Create: `src/search/retrievalPipeline.ts`
- Create: `src/search/retrievalPipeline.test.ts`

**Interfaces:**
- Consumes: `PaperRecord[]`, `PaperAnalysis[]`, DeepSeek query expansion.
- Produces: `tokenizeIcText(text)`, `LocalPaperIndex`, `retrieveCandidates(query, limit = 50)`.

- [ ] **Step 1: Write failing bilingual terminology test**

```ts
it('normalizes Chinese and English chiplet terminology', () => {
  const tokens = tokenizeIcText('芯粒 die-to-die UCIe 2.5D互连')
  expect(tokens).toEqual(expect.arrayContaining(['chiplet', 'die-to-die', 'ucie', '2.5d', '互连']))
})
```

- [ ] **Step 2: Write failing retrieval limit test**

Index 80 literal fixtures and assert `retrieveCandidates('thermal TSV', 50)` returns exactly 50 or fewer results ordered by descending relevance.

- [ ] **Step 3: Run tests and confirm RED**

Run: `npm run test:run -- src/search`
Expected: FAIL because tokenizer and index are missing.

- [ ] **Step 4: Implement taxonomy, tokenizer and MiniSearch wrapper**

Index title with boost 5, keywords 4, abstract 3, methods/findings 2 and full text 1. Deduplicate expanded terms and fall back to the original query if DeepSeek expansion fails.

- [ ] **Step 5: Verify GREEN**

Run: `npm run test:run -- src/search`
Expected: tokenizer and retrieval tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/search
git commit -m "feat: add IC-aware local retrieval"
```

### Task 6: IC-Influence Rank 与核心论文多样性筛选

**Files:**
- Create: `src/influence/pageRank.ts`
- Create: `src/influence/pageRank.test.ts`
- Create: `src/influence/scoring.ts`
- Create: `src/influence/scoring.test.ts`
- Create: `src/influence/mmr.ts`
- Create: `src/influence/mmr.test.ts`
- Create: `src/influence/referenceMatcher.ts`
- Create: `src/influence/referenceMatcher.test.ts`
- Create: `src/api/openAlexClient.ts`

**Interfaces:**
- Produces: `personalizedPageRank(graph, personalization, options)`, `scorePaper(features)`, `selectDiverseCorePapers(candidates, count)`, `matchLocalReferences(papers, analyses)`.

- [ ] **Step 1: Write failing PageRank tests**

```ts
it('ranks a paper cited by two relevant papers above an isolated paper', () => {
  const scores = personalizedPageRank(graphFixture, { a: .4, b: .3, c: .2, d: .1 })
  expect(scores.c).toBeGreaterThan(scores.d)
  expect(Object.values(scores).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6)
})
```

- [ ] **Step 2: Write failing score weight and MMR tests**

Use hand-derived feature literals to assert score `0.4*r + 0.3*p + 0.15*f + 0.1*e + 0.05*b`. Assert MMR chooses a slightly lower-scoring paper from a second domain instead of a near-duplicate third paper from the first domain.

- [ ] **Step 3: Run tests and confirm RED**

Run: `npm run test:run -- src/influence`
Expected: FAIL because ranking functions are missing.

- [ ] **Step 4: Implement weighted PageRank, scoring, matching and MMR**

Use damping `0.85`, tolerance `1e-8`, maximum 100 iterations and normalized personalization. Apply semantic edge multipliers `foundation=1.25`, `extends=1.1`, `validates=1.0`, `contradicts=1.0`, `background=.55`, `selfCitation=.7`.

- [ ] **Step 5: Implement optional OpenAlex enrichment**

Fetch by DOI, select only `id,title,publication_year,cited_by_count,counts_by_year`, cache results, and return `undefined` on unavailable metadata so local ranking remains usable.

- [ ] **Step 6: Verify GREEN**

Run: `npm run test:run -- src/influence`
Expected: all influence tests pass and scores sum to 1.

- [ ] **Step 7: Commit**

```bash
git add src/influence src/api/openAlexClient.ts
git commit -m "feat: rank influential IC papers"
```

### Task 7: 上传、AI 配置、论文库和任务界面

**Files:**
- Create: `src/app/routes.tsx`
- Create: `src/features/onboarding/OnboardingPage.tsx`
- Create: `src/features/onboarding/OnboardingPage.test.tsx`
- Create: `src/features/settings/ApiSettingsForm.tsx`
- Create: `src/features/settings/ApiSettingsForm.test.tsx`
- Create: `src/features/library/LibraryPage.tsx`
- Create: `src/features/jobs/JobsPage.tsx`
- Create: `src/components/AppShell.tsx`
- Create: `src/components/FileDropzone.tsx`
- Create: `src/components/StatusBadge.tsx`

**Interfaces:**
- Consumes: storage repository, DeepSeek client, processing queue.
- Produces: navigable onboarding, library and job-management screens.

- [ ] **Step 1: Write failing interaction tests**

```tsx
it('does not enable build until files and a valid connection exist', async () => {
  render(<OnboardingPage />)
  expect(screen.getByRole('button', { name: '开始构建论文库' })).toBeDisabled()
})

it('warns before persisting an API key locally', async () => {
  render(<ApiSettingsForm />)
  await user.click(screen.getByLabelText('在本机保存 Key'))
  expect(screen.getByText(/仅保存在当前浏览器/)).toBeInTheDocument()
})
```

- [ ] **Step 2: Run tests and confirm RED**

Run: `npm run test:run -- src/features/onboarding src/features/settings`
Expected: FAIL because the pages do not exist.

- [ ] **Step 3: Implement high-fidelity onboarding and app shell**

Match the approved mockup: dark navy top/side navigation, serif hero, ice-blue canvas, upload queue, API form, local privacy chip, storage meter, responsive collapse and keyboard focus.

- [ ] **Step 4: Connect real queue and repository state**

Display batch progress and allow pause, continue, retry and remove. A single failed paper stays isolated from the rest of the queue.

- [ ] **Step 5: Verify GREEN**

Run: `npm run test:run -- src/features/onboarding src/features/settings && npm run typecheck`
Expected: interaction tests pass and TypeScript exits 0.

- [ ] **Step 6: Commit**

```bash
git add src/app src/components src/features/onboarding src/features/settings src/features/library src/features/jobs
git commit -m "feat: build local paper library workflow"
```

### Task 8: 智能检索、内容知识树和影响力工作台

**Files:**
- Create: `src/features/search/SearchPage.tsx`
- Create: `src/features/search/SearchPage.test.tsx`
- Create: `src/features/graph/GraphWorkbench.tsx`
- Create: `src/features/graph/KnowledgeTree.tsx`
- Create: `src/features/graph/InfluenceGraph.tsx`
- Create: `src/features/graph/PaperDetailPanel.tsx`
- Create: `src/features/graph/graphModel.ts`
- Create: `src/features/graph/graphModel.test.ts`
- Modify: `src/app/routes.tsx`
- Modify: `src/styles/app.css`

**Interfaces:**
- Consumes: retrieval candidates, ranking scores, paper analyses and citation edges.
- Produces: query-to-50-candidates-to-12/15-core-papers flow and interactive graph/detail views.

- [ ] **Step 1: Write failing result explanation test**

```tsx
it('shows the selected paper score breakdown and evidence page', async () => {
  render(<GraphWorkbench result={researchResultFixture} />)
  await user.click(screen.getByText('Thermal-Aware Chiplet Placement'))
  expect(screen.getByText('综合得分')).toBeInTheDocument()
  expect(screen.getByText(/PAGE 7/)).toBeInTheDocument()
})
```

- [ ] **Step 2: Write failing graph-model test**

Given analyses in two domains and three citation edges, assert `buildInfluenceGraph` returns unique paper nodes, weighted edges and role labels `foundation`, `hub`, `frontier`.

- [ ] **Step 3: Run tests and confirm RED**

Run: `npm run test:run -- src/features/search src/features/graph`
Expected: FAIL because search and graph workbench are missing.

- [ ] **Step 4: Implement retrieval page and D3/SVG graphs**

Render the approved three-column workbench: left filters, central zoomable/drag graph and right evidence panel. Provide tabs for content knowledge tree, influence graph, core papers and scoring explanation.

- [ ] **Step 5: Verify GREEN and responsiveness**

Run: `npm run test:run -- src/features/search src/features/graph && npm run typecheck`
Expected: tests pass and no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/features/search src/features/graph src/app/routes.tsx src/styles/app.css
git commit -m "feat: add research retrieval and graph workbench"
```

### Task 9: 闭环验证、GitHub Pages 发布配置和交付

**Files:**
- Create: `src/app/researchFlow.integration.test.tsx`
- Create: `.github/workflows/deploy-pages.yml`
- Create: `README.md`
- Create: `.env.example`
- Modify: `vite.config.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: all previous modules.
- Produces: tested static build and reproducible GitHub Pages deployment.

- [ ] **Step 1: Write failing end-to-end component integration test**

Use fake IndexedDB, a small PDF fixture and a complete fake DeepSeek response. Verify import, analysis completion, search, 12–15 core results and graph opening without real network calls.

- [ ] **Step 2: Run integration test and confirm RED**

Run: `npm run test:run -- src/app/researchFlow.integration.test.tsx`
Expected: FAIL at the first missing integration boundary.

- [ ] **Step 3: Wire missing boundaries and GitHub Pages base path**

Set Vite `base` to `./`, use `HashRouter`, and add a GitHub Actions workflow with Node setup, `npm ci`, `npm run test:run`, `npm run build`, Pages artifact upload and deploy actions.

- [ ] **Step 4: Document user-visible privacy and deployment**

README must state that each visitor supplies their own API Key, files remain in that browser, DeepSeek receives selected text for analysis, and clearing site data removes the local library.

- [ ] **Step 5: Run full verification**

Run: `npm run test:run && npm run typecheck && npm run build`
Expected: zero failing tests, TypeScript exit 0 and `dist/index.html` produced without any API Key.

- [ ] **Step 6: Inspect the built artifact for secrets**

Run: `rg -n "sk-[A-Za-z0-9]|DEEPSEEK_API_KEY" dist`
Expected: no matches.

- [ ] **Step 7: Commit**

```bash
git add .github README.md .env.example package.json vite.config.ts src/app/researchFlow.integration.test.tsx
git commit -m "chore: prepare GitHub Pages delivery"
```
