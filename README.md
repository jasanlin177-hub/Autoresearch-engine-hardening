# Autoresearch Engine Hardening

> **美股深度研究平台（穩健版）** — 以張磊四維框架迭代補強研究，直到品質達標（≥ 95/100）。

Fork 自 [bear0103papa/Equityautoresearch](https://github.com/bear0103papa/Equityautoresearch)，在原架構基礎上對實際使用痛點進行補強，並引入確定性金融數據預取機制（**股價鎖定 + FCF/SBC + FCF PEG**），確保報告數字來自 API 而非 LLM 訓練記憶。

---

## 補強清單

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
| 10 | **股價鎖定** | `main()` Step 0 強制呼叫 `ninja_api(stockprice)`，寫入報告頂部，LLM 不再使用訓練記憶中的舊股價 |
| 11 | **FCF / SBC 計算** | 從 SEC EDGAR XBRL 確定性抓取 OCF / CapEx / SBC，程式計算 FCF 與 FCF−SBC（真實股東盈利）|
| 12 | **FCF PEG** | 自動計算 P/FCF、FCF 成長率、FCF PEG（比 P/E PEG 更適合 SaaS 公司估值）|

---

## 補強 #10–12 說明：為何需要確定性預取

### 問題根源

原架構中 `ninja_api(stockprice)` 是 LLM 的**可選工具**。LLM 若「認為自己知道」某公司股價（來自訓練資料），就不呼叫 API，直接把記憶中的舊價格寫進報告。

> 實際案例：DUOL 真實股價 ~$108，報告卻出現 ~$320（LLM 訓練期間的歷史價格）。

### 解決架構

> **數值由程式計算並寫入，LLM 負責解釋，不負責生成數字。**

```
main() 啟動
  │
  ├── Step 0（LLM 介入前）
  │     ├── fetchCurrentPrice()      → ninja_api(stockprice)
  │     ├── fetchSecXbrlMetrics()    → SEC EDGAR XBRL JSON
  │     ├── calculateValuationMetrics()
  │     └── injectMetricsHeader()   → 寫入報告頂部固定區塊
  │
  └── Step 1+ LLM gap-fill 迴圈（只能讀取、引用上方區塊，不能覆蓋）
```

### 注入的指標區塊（範例）

```markdown
## 關鍵估值指標（程式自動計算，每次執行時更新）

> 資料日期：2026-05-10 | 股價來源：API Ninjas | 財務來源：SEC EDGAR XBRL（FY2025）

| 指標 | 數值 | 說明 |
|------|------|------|
| 當前股價 | $107.99 | 2026-05-10 收盤 |
| 市值 | $5,184M | 股價 × 稀釋股數 48M |
| FY2025 P/S | 5x | 市值 / 年度營收 $1,038M |
| FY2025 FCF | $370M | OCF $388M − CapEx $18M |
| FCF Margin | 35.6% | FCF / 營收 |
| FCF − SBC | $233M | 真實股東盈利（扣除 SBC $137M）|
| FCF−SBC Margin | 22.4% | |
| P/FCF | 14x | 股價 / FCF per share |
| FCF PEG | 0.4 | P/FCF 14x ÷ FCF 成長率 35% (FY2024→FY2025) |
```

### 資料來源

| 指標 | 來源 |
|------|------|
| 當前股價 | API Ninjas `stockprice` |
| OCF / CapEx / SBC / 稀釋股數 | SEC EDGAR XBRL（`data.sec.gov`，免費） |
| 營收 | SEC EDGAR XBRL |
| EPS（PEG 計算用） | API Ninjas `earnings_historical` |

---

## 功能一覽

| 功能 | 說明 |
|---|---|
| 🔄 **迭代研究** | 最多 20 輪，每輪自動找缺口、補研究、重新評分 |
| 📊 **四維評分** | 張磊框架：環境 → 生意 → 組織 → 人，目標 ≥ 95/100 |
| 📌 **股價鎖定** | 每次執行強制預取即時股價，寫入報告，LLM 不可覆蓋 |
| 💰 **FCF / SBC** | 程式計算 FCF、FCF−SBC Margin，直接注入報告 |
| 📈 **FCF PEG** | 自動計算，適合 SaaS 公司估值驗證 |
| 📄 **Plateau 偵測** | 連續 3 輪 rolling avg 差值 < 2 分自動停止，避免無效迭代 |
| 🛡️ **PDF 防護** | URL + Content-Type 雙重偵測，永不嘗試下載 PDF |
| 📑 **SEC XBRL** | 直接查 SEC EDGAR 結構化財務 JSON，不依賴 PDF 年報 |
| 🎙️ **法說逐字稿** | stockanalysis.com HTML 免費抓取，自動儲存至 transcripts/ |
| 💸 **成本控制** | Google Studio 免費 → OpenRouter 免費 → Flash 付費，三層降級 |

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
# ── 第一層：Google AI Studio（免費 Gemini Pro 額度，優先使用）──
GOOGLE_AI_STUDIO_API_KEY=AIza...        # https://aistudio.google.com/apikey

# ── 第二 + 三層：OpenRouter（必填其一；免費模型 + 付費 Flash 共用同一把 key）──
OPENROUTER_API_KEY=sk-or-v1-...         # https://openrouter.ai

# ── 搜尋（建議設定）──
BRAVE_SEARCH_API_KEY=...                # https://brave.com/search/api/

# ── 備用財報（可選）──
NINJA_API_KEY=...                       # https://api-ninjas.com（股價查詢必填）
```

> **`GOOGLE_AI_STUDIO_API_KEY` 和 `OPENROUTER_API_KEY` 至少填一個。** 建議兩個都設定——Google Studio 走免費額度；OpenRouter 免費模型額度耗盡後，自動降級為 **Gemini Flash 付費層**，使用的仍是同一把 `OPENROUTER_API_KEY`。`BRAVE_SEARCH_API_KEY` 不設定時自動 fallback 至 DuckDuckGo Lite。`NINJA_API_KEY` 用於即時股價（補強 #10）；財報資料由 `fetch_sec_xbrl` 直取，不依賴 Ninja API。

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
  --model google/gemini-3.1-pro-preview  \   # LLM 模型
  --why "評估 AI 晶片護城河"  \   # 研究動機（多字支援）
  --skip-polish                  # 略過最後整理輪
```

### 只跑評分（不研究）

```bash
npm run score -- --ticker NVDA
```

---

## 三個結構化財務工具（補強 #9）

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

> 以上三個工具優先於 `ninja_api`；Ninja API 降為備用（股價查詢除外）。

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
  ├── 關鍵估值指標（程式自動計算，每次執行時更新）  ← 補強 #10-12 注入
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
  │   ├── 2.5 DCF 估值 + 三情境 IRR
  │   ├── 2.6 Max 滲透率模型（付費轉換路徑）
  │   └── 2.7 估值壓縮壓力測試
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
| 即時股價 | API Ninjas `stockprice`（補強 #10）|
| 現金流量 / SBC / 稀釋股數 | SEC EDGAR XBRL API（補強 #11）|
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
│   ├── initial-max-runner.ts   # 主研究迴圈（含 12 項補強）
│   └── initial-max-scorer.ts   # 四維評分引擎（LLM + heuristic + retry）
├── skills/
│   └── initial-max/SKILL.md    # 迭代研究框架指令
├── data/companies/<ticker>/
│   ├── <ticker>_Initial_MAX.md      # 研究報告（Markdown）
│   ├── <ticker>_Initial_MAX.md.bak  # 自動備份（順稿前）
│   └── transcripts/                 # 法說逐字稿快取
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
