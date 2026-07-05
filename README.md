# TaiEquityautoresearch

> **台灣市場深度研究平台** — 自動執行機構級股票研究，輸出可直接閱讀的 PDF / Word 報告。

本專案 Fork 自 [Roger's Letter](https://github.com/bear0103papa) 的 [Equityautoresearch](https://github.com/bear0103papa/Equityautoresearch)，在原架構基礎上針對台灣市場（上市、上櫃、興櫃）進行深度改造。感謝 Roger 的原創設計與開源精神。

---

## 功能一覽

| 功能 | 說明 |
|---|---|
| 🔄 **迭代研究** | 最多 N 輪（預設 20），每輪自動找缺口、補研究、重新評分 |
| 📊 **四維評分** | 張磊（高瓴資本）框架：環境 → 生意 → 組織 → 人 |
| 🏷️ **市值分級門檻** | 大型（≥500億）/ 中型（30–500億）/ 小型（<30億）三級達標線 |
| 🔍 **中位數取樣** | 同時跑 3 次 Flash 評分取中位數，抑制模型非確定性 |
| 📄 **PDF 報告** | 含即時財務封面、表格、超連結、繁體中文 |
| 📝 **Word 報告** | 同上，`.docx` 格式，可直接編輯 |
| 💰 **成本控制** | Google AI Studio（免費）→ OpenRouter 免費模型 → Flash 付費降級，拒絕意外使用非 Google 模型 |
| 🇹🇼 **台股適配** | MOPS 公開資訊觀測站、Poorstock 法說摘要、Brave Search、台幣 DCF |

---

## 安裝

```bash
git clone https://github.com/jasanlin177-hub/Autoresearch-engine-hardening.git
cd Autoresearch-engine-hardening
git checkout taiwan-stock
npm install
pip install reportlab python-docx yfinance beautifulsoup4 requests
```

### API 金鑰設定

```bash
cp .env.example .env   # 填入下列金鑰
```

| 環境變數 | 必填 | 用途 |
|---|---|---|
| `GOOGLE_AI_STUDIO_API_KEY` | ✅（主要）| Gemini Flash 研究 & 評分（免費額度優先）|
| `OPENROUTER_API_KEY` | 備援 | Google 限流時的備援 LLM |
| `BRAVE_SEARCH_API_KEY` | ✅ | 網路搜尋 + CEO 訪談普查 |
| `NINJA_API_KEY` | 選填 | API Ninjas 財務資料 |

> 兩組 LLM 金鑰至少需設定一個；建議兩個都設，Google Studio 優先使用。

---

## 使用方式

### 執行台股深度研究

```bash
npm run tw-research -- --ticker 7738
```

```
選項：
  --ticker         股票代號（必填）
  --rounds         最多輪數（預設 20）
  --model          研究用 LLM（預設 google/gemini-2.5-flash）
  --engine         研究引擎：api（預設，Gemini）｜claude-cli｜codex
  --scorer-engine  評分引擎：api（預設，Gemini）｜claude-cli｜codex
  --score-only     只跑評分，不執行研究
  --skip-polish    略過結束後的順稿整理輪
  --force          跳過非 Google 模型安全檢查
```

### 三種研究／評分引擎

研究與評分各可獨立選引擎，`--engine` 管研究、`--scorer-engine` 管評分：

| 引擎 | 底層 | 計費 | 適用 |
|---|---|---|---|
| `api`（預設） | Gemini API | 依 token（Flash 免費額度優先） | 快、便宜；Flash 指令遵循較弱 |
| `claude-cli` | Claude Code CLI（`claude -p`） | 吃 Claude 訂閱額度 | 指令遵循強；每輪數分鐘 |
| `codex` | OpenAI Codex CLI（`codex exec`） | 吃 ChatGPT 訂閱額度 | 指令遵循強；評分偏嚴 |

> CLI 引擎需先在本機安裝並登入對應 CLI（`claude` / `codex`），使用訂閱制（OAuth）認證，不需額外 API 金鑰。

```bash
# 用 Codex 研究、Gemini 評分（預設評分）
npm run tw-research-codex -- --ticker 7738

# 用 Claude CLI 研究
npm run tw-research-cli -- --ticker 7738

# 研究用 Codex、評分也用 Codex（偏嚴，較貼 rubric 字面）
npm run tw-research-codex -- --ticker 7738 --scorer-engine codex
```

**PDF 預先下載**：研究引擎啟動每輪前，runner 會掃描主檔內既有的 `.pdf` 連結（如公司年報），以瀏覽器 User-Agent 於本機下載＋解析文字（`src/pdf-prefetch.ts`），附進 prompt 供 agent 直接引用——繞過部分官網對非瀏覽器請求回 403 的封鎖。解析結果快取於 `data/companies/{ticker}/pdf_cache/`。

**主檔備份**：每輪 gap-fill 前與 polish 前，主檔自動快照至 `data/companies/{ticker}/history/`（該目錄已 gitignore，為本機唯一回溯點）。

### 只跑評分

```bash
npm run tw-score -- --ticker 7738            # Gemini（預設）
npm run tw-score-cli -- --ticker 7738        # Claude Code CLI
npm run tw-score-codex -- --ticker 7738      # OpenAI Codex CLI
```

### 產出報告

```bash
# PDF（含即時股價、財務封面）
python scripts/generate_pdf.py data/companies/7738/7738_Initial_MAX.md 7738_Report.pdf

# Word
python scripts/generate_word.py data/companies/7738/7738_Initial_MAX.md 7738_Report.docx --ticker 7738
```

---

## LLM 呼叫架構（三層成本控制）

```
第一層  Google AI Studio      Gemini 2.5 Flash，免費額度優先
   ↓（限流 / 失敗時）
第二層  OpenRouter 免費模型    Gemma / Llama / Nemotron（noFreeTier 旗標可跳過）
   ↓（免費額度耗盡）
第三層  OpenRouter 付費模型    強制降為 Gemini Flash，拒絕非 Google 付費模型
```

**安全檢查**：偵測到非 Google 模型時，若未加 `--force` 旗標，程式直接中止並提示確認，防止意外高帳單。

**評分器固定使用 Flash**：Gemini Pro 系列在評分情境下會產生系統性偏差（組織 / 人維度 = 0），已明確拒絕。

---

## 評分框架

採**張磊四維框架**，總分 100 分。**達標線依市值自動分級**，市值只影響達標門檻，不影響各維度的計分邏輯。

### 三級達標門檻

| 市值 | 總分 | 環境 | 生意 | 組織 | 人 |
|---|---|---|---|---|---|
| 大型（≥ 500 億） | ≥ 95 | ≥ 16 | ≥ 30 | ≥ 16 | ≥ 20 |
| 中型（30–500 億）| ≥ 75 | ≥ 14 | ≥ 25 | ≥ 13 | ≥ 14 |
| 小型（< 30 億）  | ≥ 60 | ≥ 12 | ≥ 22 | ≥ 10 | ≥ 12 |

> 市值由研究報告中的「市值 ×× 億」自動擷取，未能擷取時套用中型門檻。

### 各維度滿分

| 維度 | 滿分 | 核心要求 |
|---|---|---|
| 一、環境 | 20 | 產業結構、競爭態勢、法規、地緣政治 |
| 二、生意 | 35 | 商業模式、財務歷史、月營收趨勢、DCF 估值 |
| 三、組織 | 20 | 治理結構、ESG、廠區分布 |
| 四、人   | 25 | CEO 背景與訪談、管理團隊、文化 |

### 必達項（缺一不過關）

- `2.3` 月營收趨勢（最近 12 個月）
- `2.4` 前五大客戶集中度（來自年報）
- `2.5` 台幣計價 DCF + 三情境 IRR（Bull / Base / Bear）
- `1.3` 兩岸地緣政治風險評估

### 人維度評分說明

「人」維度以**涵蓋率 × 深度**計分，與訪談篇數的絕對數量無直接關係。低調 CEO / 小型股揭露有限屬正常，Brave Search 普查（`{CEO姓名} 專訪 OR 訪談`）提供錨點參考，不作為硬性扣分依據。

---

## 資料來源

| 類型 | 來源 |
|---|---|
| 財務報表 | 公開資訊觀測站（MOPS）`ajax_t164sb04` |
| 月營收 | MOPS `ajax_t05st10_ifrs` |
| 重大訊息 | MOPS `ajax_t05st01`（近 2 個 ROC 年度）|
| 法說會摘要 | MOPS `ajax_t100sb07_1` + [Poorstock.com](https://poorstock.com) AI 全文摘要 |
| 年報（PDF）| MOPS 直連下載 |
| CEO 訪談普查 | Brave Search API |
| 網路搜尋 | Brave Search API / API Ninjas |
| 股價 / 財務指標 | Yahoo Finance（yfinance）|

---

## 評分穩定性設計

| 措施 | 效果 |
|---|---|
| `temperature: 0` | 壓低 Flash 隨機性 |
| `thinkingBudget: 0` | 關閉思考 token（非 thinking-mandatory 模型）|
| 中位數取樣（×3）| 消除殘餘底噪，取 3 次總分的中位數那輪 |
| CEO 訪談普查快取 | 存至 `data/companies/{ticker}/ceo_census.json`，避免每次 Brave 查詢結果不同造成錨點偏移 |

---

## 報告結構

```
封面
  ├── 公司名稱 + 股票代號
  ├── 即時股價 / 市值 / 產業 / 產出日期       ← Yahoo Finance 即時抓取
  ├── 財務指標帶（TTM 營收成長、P/E、ROE、PEG、P/B）
  └── 季度 EPS / 52 週高低

一、環境分析
  1.1 產業概況與總體經濟
  1.2 競爭格局（五力分析）
  1.3 地緣政治風險
  1.4 法規環境

二、生意分析
  2.1 商業模式與護城河
  2.2 財務健康度（損益 / 資產負債 / 現金流）
  2.3 月營收趨勢（12 個月）
  2.4 客戶集中度
  2.5 DCF 估值 + 三情境 IRR

三、組織分析
  3.1 廠區 / 營運據點
  3.2 公司治理
  3.3 ESG

四、人的分析
  4.1 CEO 背景與訪談記錄
  4.2 管理團隊與文化

結論 / IRR 模型總覽
```

---

## 專案結構

```
TaiEquityautoresearch/
├── src/
│   ├── initial-max-runner.ts   # 主研究迴圈（多輪迭代 + 成本控制）
│   ├── initial-max-scorer.ts   # 四維評分引擎（市值分級 + 中位數取樣）
│   ├── mops.ts                 # MOPS / Poorstock 資料抓取（財報、法說、重大訊息）
│   ├── llm.ts                  # LLM 呼叫層（三層 fallback）
│   └── tw-data.ts              # 台股輔助工具
├── skills/
│   ├── tw-stock/SKILL.md       # 台股研究指令（研究 prompt）
│   └── initial-max/SKILL.md    # 迭代研究框架定義
├── scripts/
│   ├── generate_pdf.py         # PDF 報告產生器（繁中、表格、超連結）
│   ├── generate_word.py        # Word 報告產生器（支援任意 ticker）
│   ├── fetch_financials.py     # Yahoo Finance 財務資料抓取
│   └── report.css              # HTML 報告樣式
├── data/companies/<ticker>/    # （gitignored）
│   ├── <ticker>_Initial_MAX.md # 研究報告 Markdown 原始檔
│   ├── ceo_census.json         # CEO 訪談普查快取
│   └── official/               # MOPS 下載的 PDF / txt
├── .env.example
└── package.json
```

---

## 授權

MIT License

```
Copyright (c) 2026 Roger Chen (original Equityautoresearch)
Copyright (c) 2026 jasanlin177 (TaiEquityautoresearch — Taiwan-market fork)
```

本專案在 MIT 授權下自由使用、修改、散佈。**報告內容僅供參考，不構成投資建議。**
