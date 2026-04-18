/**
 * Taiwan stock data utilities.
 * Provides helper functions for TWSE/TPEx tickers and data source URLs.
 */

const CURRENT_YEAR = new Date().getFullYear();

// ─── Ticker helpers ───────────────────────────────────────────────────────────

export function isTaiwanStock(ticker: string): boolean {
  const t = ticker.trim().toUpperCase();
  // Pure 4-digit number
  if (/^\d{4}$/.test(t)) return true;
  // 4-digit number with .TW or .TWO suffix
  if (/^\d{4}\.(TW|TWO)$/.test(t)) return true;
  return false;
}

export function normalizeTWTicker(ticker: string): string {
  return ticker.trim().toUpperCase().replace(/\.(TW|TWO)$/, '');
}

// ─── Data fetching (returns fetch_url instructions) ───────────────────────────

/**
 * Returns a prompt instructing the agent to use fetch_url to retrieve MOPS financials.
 * The agent should call: fetch_url(url)
 */
export async function fetchMOPSFinancials(ticker: string, years: number = 5): Promise<string> {
  const id = normalizeTWTicker(ticker);
  const endYear = CURRENT_YEAR;
  const startYear = endYear - years + 1;

  const url =
    `https://mops.twse.com.tw/mops/web/ajax_t05st10_ifrs` +
    `?encodeURIComponent=1&step=1&firstin=1&off=1&keyword4=` +
    `&code1=&TYPEK=sii&isnew=false&co_id=${id}` +
    `&year=${startYear}&season=01`;

  return (
    `請使用 fetch_url 工具抓取以下 MOPS 公開資訊觀測站財報頁面：\n\n` +
    `fetch_url("${url}")\n\n` +
    `此頁面包含 ${id} 公司 ${startYear}–${endYear} 年度合併綜合損益表（TIFRS）。` +
    `若需其他年度，調整 year 參數即可。`
  );
}

/**
 * Returns a prompt instructing the agent to use fetch_url to retrieve TWSE monthly revenue.
 */
export async function fetchTWSEMonthlyRevenue(ticker: string): Promise<string> {
  const id = normalizeTWTicker(ticker);
  const now = new Date();
  const year = now.getFullYear() - 1911; // ROC calendar year
  const month = String(now.getMonth() + 1).padStart(2, '0');

  const url =
    `https://www.twse.com.tw/rwd/zh/afterTrading/FMSRFK` +
    `?date=${year}${month}01&stockNo=${id}&response=json`;

  return (
    `請使用 fetch_url 工具抓取台灣證交所月營收資料（每月 10 日更新）：\n\n` +
    `fetch_url("${url}")\n\n` +
    `此 API 回傳 ${id} 近期月營收 JSON。建議至少追蹤最近 12 個月趨勢，` +
    `可調整 date 參數（民國年+月份）取得歷史資料。`
  );
}

/**
 * Returns a prompt instructing the agent to use fetch_url to retrieve investor conference data.
 */
export async function fetchInvestorConference(ticker: string, year: number = CURRENT_YEAR): Promise<string> {
  const id = normalizeTWTicker(ticker);

  const url =
    `https://mops.twse.com.tw/mops/web/t100sb01` +
    `?encodeURIComponent=1&step=1&firstin=1&off=1` +
    `&TYPEK=sii&year=${year - 1911}&co_id=${id}`;

  return (
    `請使用 fetch_url 工具抓取 MOPS 法說會（投資人說明會）資料：\n\n` +
    `fetch_url("${url}")\n\n` +
    `此頁面列出 ${id} 公司 ${year} 年（民國 ${year - 1911} 年）` +
    `所有法人說明會公告，包含簡報、逐字稿及影片連結（若有）。`
  );
}

// ─── Search query templates ───────────────────────────────────────────────────

export interface TWSearchQueries {
  ceoInterview: string;
  analystReport: string;
  industryReport: string;
  esgReport: string;
  earningsCall: string;
}

export function getTWSearchQueries(
  ticker: string,
  companyName: string,
  ceoName: string
): TWSearchQueries {
  const id = normalizeTWTicker(ticker);
  const year = CURRENT_YEAR;

  return {
    ceoInterview: `"${ceoName}" 訪談 商業周刊 OR 天下雜誌`,
    analystReport: `"${companyName}" 研究報告 ${id}`,
    industryReport: `"${companyName}" 產業 ITRI OR MIC 台灣 市場規模`,
    esgReport: `"${companyName}" ESG 永續報告書`,
    earningsCall: `"${companyName}" ${year} 法人說明會 逐字稿 site:mops.twse.com.tw`,
  };
}

// ─── Data sources info ────────────────────────────────────────────────────────

export function getTWDataSourcesInfo(): string {
  return `## 台股主要資料來源

### 財務數據
| 名稱 | URL | 說明 |
|------|-----|------|
| 公開資訊觀測站（MOPS） | https://mops.twse.com.tw | 財報、法說會、重大訊息 |
| 台灣證券交易所（TWSE） | https://www.twse.com.tw | 月營收、股價、籌碼 |
| 台灣股市資訊網 Goodinfo | https://goodinfo.tw | 財務比率、股利、殖利率 |
| CMoney | https://www.cmoney.tw | 財務分析、選股工具 |
| 富邦 e01 / 元大 API | 券商平台 | 即時報價（需帳號） |

### 財經媒體與訪談
| 名稱 | URL | 說明 |
|------|-----|------|
| 商業周刊 | https://www.businessweekly.com.tw | CEO 封面故事、企業深度 |
| 天下雜誌 | https://www.cw.com.tw | 標竿企業、產業趨勢 |
| 數位時代 | https://www.bnext.com.tw | 科技新創、數位轉型 |
| 鉅亨網 Anue | https://news.cnyes.com | 即時財經新聞、法說摘要 |
| MoneyDJ 理財網 | https://www.moneydj.com | 個股新聞、財報摘要 |

### 產業研究
| 名稱 | URL | 說明 |
|------|-----|------|
| 工業技術研究院（ITRI） | https://www.itri.org.tw | 台灣產業技術研究報告 |
| 資策會 MIC | https://mic.iii.org.tw | ICT 市場研究報告 |
| 金管會 | https://www.fsc.gov.tw | 金融監理、上市規範 |
| 經濟部工業局 | https://www.moeaidb.gov.tw | 製造業統計、補助政策 |

### 特殊場景
| 場景 | 建議資料來源 |
|------|------------|
| 有 ADR 之台股（TSM、UMC）| 可補充 ninja_api(earnings_historical) |
| ESG / 永續報告書 | 公司 IR 頁面或 TWSE 永續資訊平台 |
| 股東會議事錄 | MOPS > 股東會 > 議事錄下載 |
`;
}
