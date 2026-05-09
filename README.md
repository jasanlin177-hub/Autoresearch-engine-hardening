# Autoresearch Engine Hardening

> **美股深度研究平台（穩健版）** — 以張磊四維框架迭代補強研究，直到品質達標（≥ 95/100）。

Fork 自 [bear0103papa/Equityautoresearch](https://github.com/bear0103papa/Equityautoresearch)，在原架構基礎上對 9 個實際使用痛點進行補強，並引入結構化財務直取工具取代不穩定的 Ninja API。

---

## 補強清單（9 項）

| # | 類別 | 說明 |
|---|---|---|
| 1 | `fetchUrl` | PDF URL / Content-Type 偵測 + 15s AbortController timeout，避免永久卡死 |
| 2 | 寫入保護 | overwrite 前自動備份 `.bak`；新內容 < 現有 50% 則拒絕寫入 |
| 3 | Polish 分數保護 | 順稿輪前後比較分數，若退步自動回滾 `.bak` |
| 4 | LLM 重試 | Scorer 最多 2 次重試（5s 間隔）；失敗回傳 `total:-1` sentinel，不污染 plateau 計算 |
| 5 | 去重保護 | `deduplicateSections` 寫入後清除重複 heading；`insertIntoSection` 有內容時自動升級為 `replaceSection` |
| 6 | Git auto-init | Runner 啟動時自動偵測並 `git init`，避免 `git commit` 失敗 |
| 7 | 多字 CLI 參數 | `--why` 等多字值正確解析（收集所有非 `--` 開頭 token）|
| 8 | LLM 成本控制 | Google AI Studio（免費）→ OpenRouter 免費模型 → Flash 付費降級 |
| 9 | 結構化財務直取 | `fetch_transcript` / `fetch_sec_xbrl` / `fetch_ir_press_release`，替代 Ninja API |

---

## 功能一覽

| 功能 | 說明 |
|---|---|
| 🔄 **迭代研究** | 最多 20 輪，每輪自動找缺口、補研究、重新評分 |
| 📊 **四維評分** | 張磊框架：環境 → 生意 → 組織 → 人，目標 ≥ 95/100 |
| 📄 **Plateau 偵測** | 連續 3 輪 rolling avg 差值 < 2 分自動停止，避免無效迭代 |
| 🛡️ **PDF 防護** | URL + Content-Type 雙重偵測，永不嘗試下載 PDF |
| 📑 **SEC XBRL** | 直接查 SEC EDGAR 結構化財務 JSON，不依賴 PDF 年報 |
| 🎙️ **法說逐字稿** | stockanalysis.com HTML 免費抓取，自動儲存至 transcripts/ |
| 💰 **成本控制** | Google Studio 免費 → OpenRouter 免費 → Flash 付費，三層降級 |

---

## 安裝

```bash
git clone https://github.com/jasanlin177-hub/Autoresearch-engine-hardening.git
cd Autoresearch-engine-hardening
git checkout fix/research-engine-hardening
npm install
```

### API 金鑰設定

```bash
cp .env.example .env   # 若無範本可手動建立
```

`.env` 內容：

```env
# 主要（必填其一）
OPENROUTER_API_KEY=sk-or-v1-...         # https://openrouter.ai

# 搜尋（建議設定）
BRAVE_SEARCH_API_KEY=...                # https://brave.com/search/api/

# 備用財報（可選，Premium 功能受限）
NINJA_API_KEY=...                       # https://api-ninjas.com
```

> `OPENROUTER_API_KEY` 為必填。`BRAVE_SEARCH_API_KEY` 不設定時自動 fallback 至 DuckDuckGo Lite。`NINJA_API_KEY` 可不填，財報資料改由 `fetch_sec_xbrl` 直取。

---

## 使用方式

### 執行美股深度研究

```bash
npm run initial-max -- --ticker NVDA
```

```bash
# 完整參數
npm run initial-max -- \
  --ticker NVDA              \   # 股票 ticker（大寫）
  --max-rounds 10            \   # 最多迭代輪次（預設 20）
  --model google/gemini-3.1-pro-preview  # LLM 模型
  --why "評估 AI 晶片護城河"  \   # 研究動機（多字支援）
  --skip-polish                  # 略過最後整理輪
```

### 只跑評分（不研究）

```bash
npm run score -- --ticker NVDA
```

---

## 三個結構化財務工具（#9 補強）

### `fetch_transcript` — 法說逐字稿

```
來源：https://stockanalysis.com/stocks/{ticker}/transcripts/q{quarter}-{year}/
特性：HTML 免費抓取，含 15s timeout + PDF 防護，截至 25,000 字元
```

### `fetch_sec_xbrl` — SEC EDGAR 結構化財務

```
來源：https://data.sec.gov/api/xbrl/companyfacts/CIK{cik}.json
特性：JSON 格式，絕不回傳 PDF；自動解析 CIK；含 Revenue / NetIncome / Assets / EPS 近 8 年 10-K
```

### `fetch_ir_press_release` — IR 新聞稿

```
來源：搜尋 + 抓取公司 IR 頁面 HTML
特性：PDF URL 自動跳過；含原始 revenue / EPS / guidance 數字
```

> 以上三個工具優先於 `ninja_api`；Ninja API 降為備用。

---

## LLM 呼叫順序（三層成本控制）

```
第一層  Google AI Studio      免費（Gemini 2.5 Pro），限速時自動跳下一層
   ↓
第二層  OpenRouter 免費模型    Gemma / Nemotron / Llama 等
   ↓
第三層  OpenRouter 付費模型    自動降級為 Gemini Flash（比 Pro 便宜 ~10x）
```

---

## 評分框架

採**張磊四維框架**，總分 100 分，達標需 ≥ 95 分且各維度達最低分：

| 維度 | 滿分 | 最低門檻 | 核心要求 |
|---|---|---|---|
| 一、環境 | 20 | 16 | 產業結構、競爭態勢、法規、地緣政治 |
| 二、生意 | 35 | 30 | 商業模式、財務歷史、DCF 估值（必達） |
| 三、組織 | 20 | 16 | 治理結構、ESG、廠區分布 |
| 四、人 | 25 | 20 | CEO 背景、管理團隊、文化 |

**必達項**：`2.5` DCF + 三情境 IRR（缺則不達標）。

### Plateau 停止條件

連續 3 輪的 rolling average 分差 < 2 分時自動停止迭代（即使未達 95 分），避免無效輪次消耗 API 配額。

---

## 報告結構

```
{TICKER}_Initial_MAX.md
  ├── 一、環境分析
  │   ├── 1.1 產業概況與總體經濟
  │   ├── 1.2 競爭格局（五力分析）
  │   ├── 1.3 地緣政治風險
  │   └── 1.4 法規環境
  ├── 二、生意分析
  │   ├── 2.1 商業模式與護城河
  │   ├── 2.2 財務健康度（損益 / 資產負債 / 現金流）
  │   ├── 2.3 地理 / 業務分部營收
  │   ├── 2.4 前五大客戶集中度
  │   └── 2.5 DCF 估值 + 三情境 IRR
  ├── 三、組織分析
  │   ├── 3.1 廠區 / 營運據點
  │   ├── 3.2 公司治理
  │   └── 3.3 ESG
  └── 四、人的分析
      └── 4.1 CEO 背景與訪談記錄（≥ 5 則管理層原話 + URL）
```

---

## 資料來源

| 類型 | 來源 |
|---|---|
| 法說逐字稿 | stockanalysis.com（HTML 免費） |
| 結構化財務 | SEC EDGAR XBRL API（JSON） |
| IR 新聞稿 | 公司 IR 頁面 HTML |
| 網路搜尋 | Brave Search / DuckDuckGo Lite（fallback） |
| 備用財報 | API Ninjas（需 NINJA_API_KEY） |

---

## 專案結構

```
Autoresearch-engine-hardening/
├── src/
│   ├── llm.ts                  # LLM 呼叫層（三層 fallback + 成本控制）
│   ├── initial-max-runner.ts   # 主研究迴圈（含 9 項補強）
│   └── initial-max-scorer.ts   # 四維評分引擎（LLM + heuristic + retry）
├── skills/
│   └── initial-max/SKILL.md    # 迭代研究框架指令
├── data/companies/<ticker>/
│   ├── <ticker>_Initial_MAX.md # 研究報告（Markdown）
│   ├── <ticker>_Initial_MAX.md.bak  # 自動備份（順稿前）
│   └── transcripts/            # 法說逐字稿快取
├── .env.example
└── package.json
```

---

## 授權

MIT License

```
Copyright (c) 2026 bear0103papa (original Equityautoresearch)
Copyright (c) 2026 jasanlin177 (Autoresearch-engine-hardening)
```

本專案在 MIT 授權下自由使用、修改、散佈。**報告內容僅供參考，不構成投資建議。**
