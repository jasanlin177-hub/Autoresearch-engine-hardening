# TaiEquityautoresearch

**AI-powered deep-research engine for Taiwan listed stocks (TWSE & TPEx).**

A Taiwan-market branch of [Roger's Letter — Equityautoresearch](https://github.com/bear0103papa/Equityautoresearch).

---

## Acknowledgement

This project is a Taiwan-market fork of **Roger's Letter's [Equityautoresearch](https://github.com/bear0103papa/Equityautoresearch)** — an automated investment research engine inspired by Andrej Karpathy's autoresearch concept.

We are deeply grateful to Roger for open-sourcing his work. The four-dimension scoring framework, iterative research loop, and report structure all originate from his project. TaiEquityautoresearch extends it with Taiwan-specific data sources (MOPS, TWSE, 商業周刊, 天下雜誌), Traditional Chinese output, and a small-cap exception system for the unique nature of TPEx-listed companies.

> 本專案係源自 **[Roger's Letter 的 Equityautoresearch](https://github.com/bear0103papa/Equityautoresearch)**，在此致上誠摯的感謝。

---

## What is TaiEquityautoresearch?

Enter a Taiwan stock ticker. Walk away. Come back to a structured investment research report — scored, sourced, and ready for judgment.

The system:
1. **Searches** — MOPS filings, TWSE revenue data, 商業周刊, 天下雜誌, 經濟日報, and more
2. **Writes** — narrative sections with direct management quotes (with URLs), financials, and DCF
3. **Scores** — Zhang Lei's (Hillhouse) four-dimension framework, 100-point scale
4. **Finds gaps** — weakest dimensions first
5. **Iterates** — up to 20 rounds, until the report hits the quality bar

**Pass bar**: total ≥ 95/100 (or ≥ 60/100 for small-cap TPEx stocks), with each dimension above its floor.

---

## Quick Start

### Requirements

- Node.js 18+
- At least one of the following API keys:
  - **Google AI Studio API key** (free, primary) — get it at https://aistudio.google.com
  - **OpenRouter API key** (pay-per-token, fallback) — get it at https://openrouter.ai
- Optional: Brave Search API key (improves web search quality)

The system tries **Google AI Studio first**. If it hits a quota limit or times out (90s), it automatically falls back to OpenRouter. You can set both keys so you never get stuck.

### Setup

```bash
git clone https://github.com/jasanlin177-hub/TaiEquityautoresearch.git
cd TaiEquityautoresearch
git checkout taiwan-stock

npm install

cp .env.example .env
# Edit .env — set at least GOOGLE_AI_STUDIO_API_KEY or OPENROUTER_API_KEY
```

### Run

```bash
# Research a Taiwan stock (e.g. 潤德 6881)
npm run tw-research -- --ticker 6881

# Score only (no new research)
npm run tw-score -- --ticker 6881

# More options
npm run tw-research -- --ticker 2330 --max-rounds 10 --tag q2review
```

### Output

```
data/companies/{TICKER}/
├── {TICKER}_Initial_MAX.md   ← main report (full narrative)
├── dcf_config.json           ← DCF assumptions
└── transcripts/              ← CEO interview transcripts

results/
└── initial-max-{ticker}-{tag}.tsv   ← per-round score log
```

---

## CLI Reference

| Flag | Description | Default |
|------|-------------|---------|
| `--ticker` | Taiwan stock number (e.g. `6881`, `2330`) | required |
| `--max-rounds` | Max research iterations | 20 |
| `--model` | Any OpenRouter model ID | `google/gemini-3.1-pro-preview` |
| `--score-only` | Score existing report, no new research | false |
| `--skip-polish` | Skip final prose polish pass | false |
| `--tag` | Label for TSV result file | today MMDD |

---

## Scoring Framework

Based on **Zhang Lei's (Hillhouse Capital) four-dimension investment framework**:

| Dimension | Max | Floor | Key requirements |
|-----------|-----|-------|-----------------|
| **Environment** 環境 | 20 | 16 | TAM with source, cross-strait geopolitical risk, regulatory trends |
| **Business** 生意 | 35 | 30 | 12-month revenue trend, top-5 customers, NTD DCF, ≥25 CEO direct quotes |
| **Organization** 組織 | 20 | 16 | Factory locations (Hsinchu/Taichung/Tainan science parks), R&D spend, ESG |
| **People** 人 | 25 | 20 | CEO timeline (education → pivots → achievements), ≥25 interview URLs |
| **Total** | **100** | **≥95** | All dimensions must clear their floor simultaneously |

**Mandatory items** (report fails without them):
- ✅ NTD-denominated DCF (3-scenario)
- ✅ Monthly revenue trend (last 12 months, TWSE source)
- ✅ Cross-strait geopolitical risk section
- ✅ Top-5 customer concentration
- ✅ Science park / factory location breakdown

**Citation standards**: every number needs a clickable URL; every quote needs quotation marks + source name + date.

---

## Small-Cap Exception

TPEx-listed companies with limited media coverage cannot realistically meet thresholds designed for large-caps like TSMC. The system automatically applies relaxed standards when any of these apply:

- Market cap < NTD 3 billion
- Listed on TPEx for less than 3 years
- Fewer than 2 cover stories in 商業周刊 / 天下雜誌
- Fewer than 3 investor conference records on MOPS

| Dimension | Standard floor | Small-cap floor |
|-----------|---------------|-----------------|
| Environment | 16 | 12 |
| Business | 30 | 22 |
| Organization | 16 | 10 |
| People | 20 | 12 |
| **Total** | **≥95** | **≥60** |

Additional adjustments: quotes per subsection 5→2, CEO interview URLs 25→5, information-scarce dimensions start from 70% of max score rather than 0.

---

## Data Sources

### Financial Data
| Source | Used for |
|--------|---------|
| [MOPS 公開資訊觀測站](https://mops.twse.com.tw) | Financials (`ajax_t05st10_ifrs`), investor conference transcripts (`t100sb01`) |
| [TWSE 台灣證券交易所](https://www.twse.com.tw) | Monthly revenue (`/rwd/zh/afterTrading/FMSRFK`) |
| [Goodinfo 台灣股市資訊網](https://goodinfo.tw) | Historical EPS, dividend, ROIC |
| CMoney | Supplemental financial data |

### Management Quotes & News
| Source | Used for |
|--------|---------|
| 商業周刊 businessweekly.com.tw | CEO cover stories, in-depth interviews |
| 天下雜誌 cw.com.tw | Entrepreneur profiles |
| 遠見雜誌 gvm.com.tw | Long-form executive interviews |
| 今周刊 businesstoday.com.tw | Financial analysis & interviews |
| 經濟日報 / 聯合新聞網 udn.com | Breaking news, company reports |
| 數位時代 bnext.com.tw | Tech company coverage |
| 鉅亨網 cnyes.com | Market news & analysis |
| MoneyDJ moneydj.com | Financial data & news |

### Industry Data
| Source | Used for |
|--------|---------|
| 工研院 ITRI itri.org.tw | TAM, industry reports |
| 資策會 MIC mic.iii.org.tw | Market sizing |
| 金管會 fsc.gov.tw | Regulatory environment |
| 內政部營建署 | Construction & renovation regulations |

---

## Report Structure

```
{TICKER}_Initial_MAX.md
├── IRR Model & Scenario Table (valuation up front)
├── Investment Thesis Summary (1–2 paragraphs)
├── KEY QUESTION
├── Score Summary Table
├── 一、環境 Environment
│   ├── 1.1 Industry origin & evolution
│   ├── 1.2 Taiwan market positioning
│   ├── 1.3 Cross-strait geopolitical risk ★
│   └── 1.4 Regulatory environment
├── 二、生意 Business
│   ├── 2.1 Business model & Five Forces
│   ├── 2.2 Financial analysis (TIFRS, 5–10yr)
│   ├── 2.3 Monthly revenue trend ★
│   ├── 2.4 Customer concentration (top 5) ★
│   └── 2.5 NTD DCF valuation ★
├── 三、組織 Organization
│   ├── 3.1 Factory / office locations ★
│   ├── 3.2 R&D capability & ESG
│   └── 3.3 Corporate governance
└── 四、人 People
    ├── 4.1 CEO timeline & interviews
    └── 4.2 Management team
```

★ = mandatory section

---

## License

MIT License — use, modify, distribute, and commercialize freely, provided copyright and license notices are preserved.

Original work © 2026 Roger Chen ([Equityautoresearch](https://github.com/bear0103papa/Equityautoresearch))
Taiwan-market fork © 2026 jasanlin177

---

## Credits

- **Original project**: [Roger's Letter — Equityautoresearch](https://github.com/bear0103papa/Equityautoresearch) — 本專案的根基，感謝 Roger 無私開源
- **Framework inspiration**: [Andrej Karpathy's autoresearch](https://github.com/karpathy/autoresearch)
- **Scoring framework**: Zhang Lei (Hillhouse Capital) four-dimension investment philosophy

---

---

## 繁體中文說明

# TaiEquityautoresearch：台灣股票深度研究自動化引擎

---

## 致謝

本專案是 **[Roger's Letter 的 Equityautoresearch](https://github.com/bear0103papa/Equityautoresearch)** 的台灣股票分支版本。

Roger 將投資研究自動化工具開源分享，以 Andrej Karpathy 的 autoresearch 概念為靈感，打造出以張磊（高瓴資本）四維框架為評分核心、能夠自動迭代補研究的投資報告生成系統。

本專案在 Roger 的架構基礎上，專為**台灣上市／上櫃公司**優化：導入公開資訊觀測站（MOPS）、台灣證交所（TWSE）月營收 API、商業周刊、天下雜誌等本地資料來源，以繁體中文撰寫研究報告，並加入小型上櫃股的評分例外條款。

**再次感謝 Roger 無私的開源貢獻。**

---

## 這是什麼？

輸入一個台股代號，讓系統自動跑完研究，回來就有一份結構完整、有出處、有 DCF 的投資報告。

系統流程：
1. **搜尋** — MOPS 財報、TWSE 月營收、商業周刊、天下雜誌、經濟日報等
2. **撰寫** — 依四維框架寫各章節，嵌入管理層直接引言（含 URL 出處）
3. **評分** — 張磊四維框架，滿分 100 分
4. **識別缺口** — 優先補分差最大的維度
5. **迭代** — 最多 20 輪，直到達標

**達標線**：一般股 ≥95 分；小型上櫃股 ≥60 分（各維度同時須達最低門檻）

---

## 快速開始

### 環境需求

- Node.js 18+
- 以下 API Key 至少填一個（建議兩個都填）：
  - **Google AI Studio API Key**（免費，優先使用）— 申請：https://aistudio.google.com
  - **OpenRouter API Key**（按 token 計費，備援）— 申請：https://openrouter.ai
- 選填：Brave Search API Key（提升搜尋品質）

系統會**優先呼叫 Google AI Studio**（免費）；若遇到額度超限或逾時（90 秒），自動切換至 OpenRouter。兩個 Key 都設定，研究就不會因額度問題中斷。

### 安裝

```bash
git clone https://github.com/jasanlin177-hub/TaiEquityautoresearch.git
cd TaiEquityautoresearch
git checkout taiwan-stock

npm install

cp .env.example .env
# 編輯 .env，至少填入 GOOGLE_AI_STUDIO_API_KEY 或 OPENROUTER_API_KEY
```

### 執行研究

```bash
# 研究台股（以潤德 6881 為例）
npm run tw-research -- --ticker 6881

# 只重新評分（不跑新研究）
npm run tw-score -- --ticker 6881

# 進階選項
npm run tw-research -- --ticker 2330 --max-rounds 10 --tag q2review
```

### 輸出位置

```
data/companies/{代號}/
├── {代號}_Initial_MAX.md   ← 主報告（完整研究敘事）
├── dcf_config.json         ← DCF 估值假設
└── transcripts/            ← CEO 訪談逐字稿

results/
└── initial-max-{代號}-{tag}.tsv   ← 每輪評分記錄
```

---

## 參數速查表

| 參數 | 說明 | 預設值 |
|------|------|--------|
| `--ticker` | 台股代號（如 `6881`、`2330`） | 必填 |
| `--max-rounds` | 最多迭代輪數 | 20 |
| `--model` | OpenRouter 模型 ID | `google/gemini-3.1-pro-preview` |
| `--score-only` | 只評分，不補研究 | false |
| `--skip-polish` | 跳過最後整理輪 | false |
| `--tag` | 結果檔名標籤 | 今日 MMDD |

---

## 評分機制

採用**張磊（高瓴資本）四維投資框架**，總分 100 分：

| 維度 | 滿分 | 最低門檻 | 必達細項 |
|------|------|---------|---------|
| **環境** | 20 | 16 | TAM（數字+出處）、兩岸地緣政治風險、法規趨勢 |
| **生意** | 35 | 30 | 近 12 月營收趨勢、前五大客戶、台幣 DCF、≥25 則 CEO 直引言 |
| **組織** | 20 | 16 | 竹科/中科/南科廠區、研發費用趨勢、ESG |
| **人** | 25 | 20 | CEO 完整故事線（學經歷→拐點→成就）、≥25 篇訪談 URL |
| **總計** | **100** | **≥95** | 各維度同時達最低門檻 |

**必達項**（缺一不達標）：
- ✅ 台幣計價 DCF（三情境）
- ✅ 月營收趨勢（近 12 個月，TWSE 來源）
- ✅ 兩岸地緣政治風險專段
- ✅ 前五大客戶集中度（來自年報）
- ✅ 竹科/中科/南科廠區分布

**出處標準**：每個數字必須附可點擊 URL；每則引言必須有引號＋媒體名稱＋日期。

---

## 小型股例外條款

上櫃小型股的公開資訊天然稀缺，不應套用為台積電設計的同等門檻。符合下列任一條件即自動啟用寬鬆模式：

- 市值 < 新台幣 30 億元
- 上櫃掛牌未滿 3 年
- 商業周刊／天下雜誌封面報導不足 2 篇
- MOPS 法說會記錄不足 3 次

| 維度 | 標準門檻 | 小型股門檻 |
|------|---------|----------|
| 環境 | 16 | 12 |
| 生意 | 30 | 22 |
| 組織 | 16 | 10 |
| 人 | 20 | 12 |
| **總分** | **≥95** | **≥60** |

其他調整：每子節引言 5 則降為 2 則；CEO 訪談 URL 25 篇降為 5 篇；資訊稀缺維度以滿分 70% 作為基準分，不因「公司太小曝光少」大量扣分。

---

## 資料搜尋來源

### 財務數據
| 來源 | 用途 |
|------|------|
| [公開資訊觀測站 MOPS](https://mops.twse.com.tw) | 財報（`ajax_t05st10_ifrs`）、法說會逐字稿（`t100sb01`） |
| [台灣證券交易所 TWSE](https://www.twse.com.tw) | 月營收（`/rwd/zh/afterTrading/FMSRFK`） |
| [Goodinfo 台灣股市資訊網](https://goodinfo.tw) | 歷史 EPS、配息、ROIC |
| CMoney | 補充財務數據 |

### 管理層語錄與新聞
| 來源 | 用途 |
|------|------|
| 商業周刊 businessweekly.com.tw | 封面故事、CEO 深度專訪 |
| 天下雜誌 cw.com.tw | 企業家長篇專題 |
| 遠見雜誌 gvm.com.tw | 高管訪談 |
| 今周刊 businesstoday.com.tw | 財經分析與訪談 |
| 經濟日報／聯合新聞網 udn.com | 即時新聞、公司報導 |
| 數位時代 bnext.com.tw | 科技公司報導 |
| 鉅亨網 cnyes.com | 市場新聞 |
| MoneyDJ moneydj.com | 財務數據與新聞 |

### 產業環境
| 來源 | 用途 |
|------|------|
| 工研院 ITRI | TAM、產業規模報告 |
| 資策會 MIC | 市場規模數據 |
| 金管會 fsc.gov.tw | 法規環境 |
| 內政部營建署 | 建築裝修法規 |

---

## 報告結構

```
{代號}_Initial_MAX.md
├── IRR 模型與情境分析表（估值第一眼）
├── 結論總結（1–2 段，獨立可讀）
├── KEY QUESTION
├── 評分總表
├── 一、環境
│   ├── 1.1 產業起源與演進
│   ├── 1.2 台灣市場定位與競爭格局
│   ├── 1.3 兩岸地緣政治風險 ★
│   └── 1.4 法規與政策環境
├── 二、生意
│   ├── 2.1 商業模式與五力分析
│   ├── 2.2 財務分析（TIFRS 近 5–10 年）
│   ├── 2.3 月營收趨勢 ★
│   ├── 2.4 客戶集中度（前五大）★
│   └── 2.5 台幣 DCF 估值 ★
├── 三、組織
│   ├── 3.1 廠區分布（竹科/中科/南科/海外）★
│   ├── 3.2 研發能力與 ESG
│   └── 3.3 公司治理
└── 四、人
    ├── 4.1 CEO 故事線（時間軸）
    └── 4.2 管理團隊
```

★ = 必達項

---

## 授權

MIT License — 可自由使用、修改、散布與商用，惟須保留版權聲明。

原始著作權 © 2026 Roger Chen（[Equityautoresearch](https://github.com/bear0103papa/Equityautoresearch)）
台股分支著作權 © 2026 jasanlin177

---

## 致謝與來源

- **原始專案**：[Roger's Letter — Equityautoresearch](https://github.com/bear0103papa/Equityautoresearch) — 本專案的根基，感謝 Roger 無私開源
- **架構靈感**：[Andrej Karpathy's autoresearch](https://github.com/karpathy/autoresearch)
- **評分框架**：張磊（高瓴資本）四維投資哲學

---

*TaiEquityautoresearch — 台股深度研究，讓 AI 在夜裡替你補研究，早上醒來看報告，用人類判斷做最後決策。*
