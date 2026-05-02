# TaiEquityautoresearch

> **台灣市場深度研究平台** — 自動執行機構級股票研究，輸出可直接閱讀的 PDF / Word 報告。

本專案 Fork 自 [Roger's Letter](https://github.com/bear0103papa) 的 [Equityautoresearch](https://github.com/bear0103papa/Equityautoresearch)，在原架構基礎上針對台灣市場（上市、上櫃、興櫃）進行深度改造。感謝 Roger 的原創設計與開源精神。

---

## 功能一覽

| 功能 | 說明 |
|---|---|
| 🔄 **迭代研究** | 最多 20 輪，每輪自動找缺口、補研究、重新評分 |
| 📊 **四維評分** | 張磊（高瓴資本）框架：環境 → 生意 → 組織 → 人 |
| 📄 **PDF 報告** | 含即時財務封面、表格、超連結、繁體中文 |
| 📝 **Word 報告** | 同上，`.docx` 格式，可直接編輯 |
| 💰 **成本控制** | Google AI Studio（免費）→ OpenRouter 免費模型 → Flash 付費降級，避免誤用 Pro 模型 |
| 🇹🇼 **台股適配** | 興櫃/小型股例外門檻、MOPS/TWSE/TPEX 資料來源、台幣 DCF |

---

## 安裝

```bash
git clone https://github.com/jasanlin177-hub/TaiEquityautoresearch.git
cd TaiEquityautoresearch
git checkout taiwan-stock          # 台股分支
npm install
pip install reportlab python-docx yfinance beautifulsoup4 requests
```

### API 金鑰設定

複製範本並填入金鑰：

```bash
cp .env.example .env
```

`.env` 內容：

```env
# 主要（免費，優先使用）
GOOGLE_AI_STUDIO_API_KEY=AIza...          # https://aistudio.google.com

# 備用（免費模型額度用完時）
OPENROUTER_API_KEY=sk-or-v1-...          # https://openrouter.ai

# 台股資料（搜尋工具）
NINJA_API_KEY=...                         # https://api-ninjas.com
BRAVE_SEARCH_API_KEY=...                  # https://brave.com/search/api/
```

> **只有 `GOOGLE_AI_STUDIO_API_KEY` 或 `OPENROUTER_API_KEY` 其中一個是必填的。**  
> 建議兩個都設定 — Google Studio 免費且優先，OpenRouter 作為備援。

---

## 使用方式

### 執行台股深度研究

```bash
npm run tw-research -- --ticker 7738
```

```bash
# 完整參數
npm run tw-research -- \
  --ticker 7738      \   # 股票代號
  --rounds 20        \   # 最多幾輪（預設 20）
  --model google/gemini-3.1-pro-preview  # LLM 模型
```

### 只跑評分（不研究）

```bash
npm run tw-score -- --ticker 7738
```

### 產出 PDF / Word 報告

```bash
# PDF（含即時股價、財務封面）
python scripts/generate_pdf.py

# Word
python scripts/generate_word.py
```

報告輸出至 `data/companies/<ticker>/`。

---

## LLM 呼叫順序（三層成本控制）

```
第一層  Google AI Studio      免費（Gemini 2.5 Pro），限速時自動跳下一層
   ↓
第二層  OpenRouter 免費模型    Gemma 4 / Nemotron / Llama 3.3 / GPT-OSS 等
   ↓
第三層  OpenRouter 付費模型    自動降級為 Gemini Flash（比 Pro 便宜 ~10x）
```

Pro 模型只走第一層（Google Studio 免費額度），付費層強制降為 Flash，避免意外高帳單。

---

## 評分框架

採**張磊四維框架**，總分 100 分，達標需 ≥ 95 分且各維度達最低分：

| 維度 | 滿分 | 最低門檻 | 核心要求 |
|---|---|---|---|
| 一、環境 | 20 | 16 | 產業結構、競爭態勢、法規、地緣政治 |
| 二、生意 | 35 | 30 | 商業模式、財務歷史、月營收趨勢、DCF 估值 |
| 三、組織 | 20 | 16 | 治理結構、ESG、廠區分布 |
| 四、人 | 25 | 20 | CEO 背景、管理團隊、文化 |

**必達項**（缺一不達標，但不會顯示在對外報告中）：

- `2.3` 月營收趨勢（最近 12 個月，來自 TWSE/TPEX）
- `2.4` 前五大客戶集中度（來自年報）
- `2.5` 台幣計價 DCF + 三情境 IRR（Bull / Base / Bear）
- `1.3` 兩岸地緣政治風險評估

### 小型股例外條款

市值 < 30 億 NTD 或資訊揭露不足的公司，自動啟用寬鬆門檻：

| 項目 | 標準門檻 | 小型股門檻 |
|---|---|---|
| 總分達標 | ≥ 95 | ≥ 60 |
| 環境最低分 | 16 | 12 |
| 生意最低分 | 30 | 22 |
| 組織最低分 | 16 | 10 |
| 人最低分 | 20 | 12 |

---

## 報告結構

```
封面
  ├── 公司名稱 + 股票代號
  ├── 即時股價 / 市值 / 產業 / 產出日期       ← 由 Yahoo Finance 即時抓取
  ├── 財務指標帶（TTM營收成長、P/E、ROE、PEG、P/B）
  └── 季度 EPS / 52 週高低

正文
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

## 資料來源

| 類型 | 來源 |
|---|---|
| 財務報表 | 公開資訊觀測站（MOPS）、TWSE Open API |
| 月營收 | 台灣證券交易所（TWSE）、TPEX |
| 法說會記錄 | MOPS 重大訊息、公司官網 |
| 新聞 / 媒體 | Brave Search、Google News |
| 股價 / 財務指標 | Yahoo Finance（yfinance） |
| 一般搜尋 | API Ninjas、Brave Search |

---

## 專案結構

```
TaiEquityautoresearch/
├── src/
│   ├── llm.ts                  # LLM 呼叫層（三層 fallback + 成本控制）
│   ├── initial-max-runner.ts   # 主研究迴圈
│   ├── initial-max-scorer.ts   # 四維評分引擎（含小型股例外）
│   └── tw-data.ts              # 台股專用資料工具
├── skills/
│   ├── tw-stock/SKILL.md       # 台股研究指令（研究 prompt）
│   └── initial-max/SKILL.md    # 迭代研究框架
├── scripts/
│   ├── fetch_financials.py     # Yahoo Finance 財務資料抓取
│   ├── generate_pdf.py         # PDF 報告產生器（繁中、表格、超連結）
│   └── generate_word.py        # Word 報告產生器
├── data/companies/<ticker>/
│   ├── <ticker>_Initial_MAX.md # 研究報告（Markdown 原始檔）
│   ├── <ticker>_Report.pdf     # PDF 報告
│   └── <ticker>_Report.docx    # Word 報告
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
