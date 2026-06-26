// MOPS 公開資訊觀測站 — 官方財報 / 月營收 / 法說會抓取
//
// 改版說明：MOPS 舊頁面的 co_id 已改為隱藏欄位，Playwright 無法 .fill() 隱藏欄位
// （locator timeout）。改用直接 POST 到 ajax_* 端點，回傳 HTML 表格，免瀏覽器、
// 更快也更穩定。端點與參數於 2026-06 驗證可用。

const MOPS = 'https://mopsov.twse.com.tw';
const POORSTOCK = 'https://poorstock.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

export interface OfficialDoc {
  type: 'conference' | 'financial' | 'annual' | 'revenue' | 'announcement' | 'earningscall';
  title: string;
  date: string;
  url: string;
  text: string;
  chars: number;
}

/** POST 到 MOPS ajax 端點，回傳原始 HTML。 */
async function mopsPost(endpoint: string, params: Record<string, string>): Promise<string> {
  const body = new URLSearchParams({
    encodeURIComponent: '1',
    step: '1',
    firstin: '1',
    off: '1',
    TYPEK: 'all',
    isnew: 'false',
    ...params,
  });
  const res = await fetch(`${MOPS}/mops/web/${endpoint}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': UA,
      Referer: `${MOPS}/`,
    },
    body,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.text();
}

/** 將 MOPS HTML 表格轉成乾淨純文字。 */
function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(parseInt(n, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\s+/g, ' ')
    .trim();
}

const thisRocYear = (): number => new Date().getFullYear() - 1911;

/** 財報是否真的有資料（避免「查無資料」空殼）。 */
function looksLikeFinancials(text: string): boolean {
  return text.length > 600 && /(資產總額|營業收入|負債總額|本期淨利)/.test(text);
}

/** 法說會資訊（含日期、地點、擇要訊息）。 */
async function fetchConferenceDocs(ticker: string): Promise<OfficialDoc[]> {
  const roc = thisRocYear();
  // 嘗試今年與去年，取有資料者
  for (const year of [roc, roc - 1]) {
    try {
      const html = await mopsPost('ajax_t100sb07_1', { co_id: ticker, year: String(year) });
      const text = htmlToText(html);
      if (text.length > 200 && /法人說明會|法說會/.test(text)) {
        const dateMatch = text.match(/\d{3}\/\d{2}\/\d{2}/);
        return [{
          type: 'conference',
          title: `法人說明會資訊（民國 ${year} 年）`,
          date: dateMatch?.[0] || String(year),
          url: `${MOPS}/mops/web/t100sb07_1`,
          text: text.slice(0, 50000),
          chars: text.length,
        }];
      }
    } catch (e: any) {
      console.error(`[mops] conference ${year} failed for ${ticker}: ${e.message}`);
    }
  }
  return [];
}

/** 合併資產負債表 + 合併綜合損益表（年報 / 第四季）。 */
async function fetchFinancialDocs(ticker: string): Promise<OfficialDoc[]> {
  const roc = thisRocYear();
  // 試最近兩個會計年度的年報（第 4 季），取第一個有資料者
  const candidates: Array<[number, string]> = [
    [roc - 1, '04'],
    [roc - 2, '04'],
  ];

  for (const [year, season] of candidates) {
    try {
      const [balanceHtml, incomeHtml] = await Promise.all([
        mopsPost('ajax_t164sb03', { co_id: ticker, year: String(year), season }),
        mopsPost('ajax_t164sb04', { co_id: ticker, year: String(year), season }),
      ]);
      const balance = htmlToText(balanceHtml);
      const income = htmlToText(incomeHtml);
      const combined = `【合併資產負債表】\n${balance}\n\n【合併綜合損益表】\n${income}`;

      if (looksLikeFinancials(balance) || looksLikeFinancials(income)) {
        return [{
          type: 'financial',
          title: `合併財務報表（民國 ${year} 年第 ${parseInt(season, 10)} 季 / 年報）`,
          date: `${year}Q${parseInt(season, 10)}`,
          url: `${MOPS}/mops/web/t164sb03`,
          text: combined.slice(0, 80000),
          chars: combined.length,
        }];
      }
    } catch (e: any) {
      console.error(`[mops] financial ${year}Q${season} failed for ${ticker}: ${e.message}`);
    }
  }
  return [];
}

/** 歷史重大訊息（ajax_t05st01）：抓近兩個民國年度，取主旨。 */
async function fetchAnnouncementDocs(ticker: string): Promise<OfficialDoc[]> {
  const roc = thisRocYear();
  const lines: string[] = [];

  for (const year of [roc, roc - 1]) {
    try {
      const html = await mopsPost('ajax_t05st01', { co_id: ticker, year: String(year), TYPEK: 'sii', firstin: '1' });
      const text = htmlToText(html);
      if (!text.includes('查無') && text.length > 500) {
        // 每行格式：  6589 | 台康生技 | 115/03/09 | 17:30:17 | 主旨...
        const rows = [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)];
        for (const row of rows) {
          const cells = [...row[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)]
            .map(c => c[1].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim());
          if (cells.length >= 5 && /\d{3}\/\d{2}\/\d{2}/.test(cells[2] ?? '')) {
            const date = cells[2].trim();
            const subject = cells[4].replace(/\s+/g, ' ').trim();
            if (subject) lines.push(`${date} ${subject}`);
          }
        }
      }
    } catch (e: any) {
      console.error(`[mops] announcement ${year} failed for ${ticker}: ${e.message}`);
    }
  }

  if (!lines.length) return [];
  const text = `【重大訊息公告】（來源：公開資訊觀測站 t05st01）\n` + lines.join('\n');
  return [{
    type: 'announcement',
    title: `重大訊息公告（近兩年）`,
    date: String(roc),
    url: `${MOPS}/mops/web/t05st01`,
    text: text.slice(0, 60000),
    chars: text.length,
  }];
}

/** 近 12 個月月營收趨勢（每月一個 POST，組成趨勢表）。 */
async function fetchRevenueDocs(ticker: string): Promise<OfficialDoc[]> {
  const now = new Date();
  // 最新已申報月份：每月 10 號前申報上月，保守從「上上月」往前抓
  let y = now.getFullYear();
  let m = now.getMonth() + 1 - 2; // JS month 0-based → 上上月
  if (m <= 0) { m += 12; y -= 1; }

  const lines: string[] = [];
  let latestDate = '';
  for (let i = 0; i < 12; i++) {
    const roc = y - 1911;
    const mm = String(m).padStart(2, '0');
    try {
      const html = await mopsPost('ajax_t05st10_ifrs', {
        co_id: ticker, year: String(roc), month: mm,
      });
      const text = htmlToText(html);
      const revMatch = text.match(/本月\s*([\d,]+)/);
      const yoyMatch = text.match(/增減百分比\s*([\-\d,.]+)/);
      if (revMatch) {
        if (!latestDate) latestDate = `${roc}/${mm}`;
        const yoy = yoyMatch ? `（YoY ${yoyMatch[1]}%）` : '';
        lines.push(`民國 ${roc} 年 ${mm} 月：營收 ${revMatch[1]} 仟元 ${yoy}`);
      }
    } catch {
      // 跳過抓不到的月份
    }
    m -= 1;
    if (m <= 0) { m = 12; y -= 1; }
  }

  if (!lines.length) return [];
  const text = `【近 12 個月月營收趨勢】（來源：公開資訊觀測站 / 單位：新台幣仟元）\n` + lines.join('\n');
  return [{
    type: 'revenue',
    title: '月營收趨勢（近 12 個月）',
    date: latestDate,
    url: `${MOPS}/mops/web/t05st10_ifrs`,
    text,
    chars: text.length,
  }];
}

/** 帶重試的 GET（poorstock 偶發 socket 中斷；漸進退避，6 次後仍失敗才放棄）。 */
async function fetchWithRetry(url: string, tries = 6): Promise<Response> {
  let lastErr: any;
  for (let i = 1; i <= tries; i++) {
    try {
      return await fetch(url, {
        headers: { 'User-Agent': UA, 'Accept-Language': 'zh-TW', Accept: 'text/html' },
        redirect: 'follow',
        signal: AbortSignal.timeout(20000),
      });
    } catch (e) {
      lastErr = e;
      // 漸進退避：1.5s, 3s, 4.5s, 6s, 7.5s（總等待約 22s）
      if (i < tries) await new Promise(r => setTimeout(r, 1500 * i));
    }
  }
  throw lastErr;
}

/**
 * poorstock 法說會 AI 摘要（散戶鬥嘴鼓）。
 * URL pattern: /earningcall/{ticker}；每檔台股一頁，內含整篇 AI 預處理的法說會重點摘要
 * （營收/產品線/市場數據/CEO 觀點），品質遠勝 MOPS 僅有的法說會「元資料」。
 * 無效代號回 404；只取最新一場法說會的內容。
 */
async function fetchEarningsCallDocs(ticker: string): Promise<OfficialDoc[]> {
  try {
    const res = await fetchWithRetry(`${POORSTOCK}/earningcall/${ticker}`);
    if (res.status === 404) return [];
    const html = await res.text();
    if (!html.includes('AI生成') && !html.includes('AI重點整理')) return [];

    const full = htmlToText(html);
    // 砍掉導覽列雜訊：從「公開資訊觀測站資訊」或「AI生成」起算才是正文
    const startIdx = (() => {
      const a = full.indexOf('公開資訊觀測站資訊');
      const b = full.indexOf('AI生成');
      if (a >= 0) return a;
      if (b >= 0) return Math.max(0, b - 40);
      return 0;
    })();
    const text = full.slice(startIdx).trim();
    if (text.length < 400) return [];

    const dateMatch = text.match(/(\d{4}\/\d{2}\/\d{2})/);
    return [{
      type: 'earningscall',
      title: `法說會 AI 重點摘要（poorstock）`,
      date: dateMatch?.[1] ?? '',
      url: `${POORSTOCK}/earningcall/${ticker}`,
      text: text.slice(0, 60000),
      chars: text.length,
    }];
  } catch (e: any) {
    console.error(`[poorstock] earningscall failed for ${ticker}: ${e.message}`);
    return [];
  }
}

export async function fetchOfficialDisclosure(
  ticker: string,
  types: ('conference' | 'financial' | 'annual' | 'revenue' | 'announcement' | 'earningscall')[] = ['conference', 'financial', 'revenue', 'announcement', 'earningscall'],
): Promise<OfficialDoc[]> {
  const results: OfficialDoc[] = [];

  for (const type of types) {
    try {
      let docs: OfficialDoc[] = [];
      switch (type) {
        case 'conference':   docs = await fetchConferenceDocs(ticker); break;
        case 'financial':
        case 'annual':       docs = await fetchFinancialDocs(ticker); break;
        case 'revenue':      docs = await fetchRevenueDocs(ticker); break;
        case 'announcement': docs = await fetchAnnouncementDocs(ticker); break;
        case 'earningscall': docs = await fetchEarningsCallDocs(ticker); break;
      }
      results.push(...docs);
      if (docs.length) console.log(`[mops] ${type}: ${docs.length} doc(s), ${docs[0].chars} chars for ${ticker}`);
      else console.log(`[mops] ${type}: no docs found for ${ticker}`);
    } catch (e: any) {
      console.error(`[mops] ${type} failed for ${ticker}:`, e.message);
    }
  }

  return results;
}
