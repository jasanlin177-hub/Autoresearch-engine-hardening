import { chromium } from 'playwright';
import { createRequire } from 'module';
const _require = createRequire(import.meta.url);
const pdfParse = _require('pdf-parse') as (buf: Buffer) => Promise<{ text: string; numpages: number }>;

const MOPS = 'https://mopsov.twse.com.tw';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

export interface OfficialDoc {
  type: 'conference' | 'financial' | 'annual' | 'revenue';
  title: string;
  date: string;
  url: string;
  text: string;
  chars: number;
}

async function parsePdf(url: string): Promise<string> {
  const res = await fetch(url, { headers: { 'User-Agent': UA, Referer: MOPS } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const parsed = await pdfParse(buf);
  return parsed.text;
}

async function submitMopsForm(url: string, ticker: string, extraFields?: Record<string, string>): Promise<{ links: { url: string; date: string }[]; tableText: string }> {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.setExtraHTTPHeaders({ 'User-Agent': UA });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });

    const coIdInput = page.locator('input[name="co_id"]').first();
    if (await coIdInput.count()) await coIdInput.fill(ticker);

    if (extraFields) {
      for (const [name, value] of Object.entries(extraFields)) {
        const el = page.locator(`input[name="${name}"], select[name="${name}"]`).first();
        if (await el.count()) await el.fill(value);
      }
    }

    // Submit and wait for AJAX
    await page.keyboard.press('Enter');
    await page.waitForTimeout(4000);

    const links = await page.$$eval('a[href*="/nas/"]', anchors =>
      (anchors as HTMLAnchorElement[])
        .filter(a => /\.pdf$/i.test(a.href))
        .map(a => {
          const row = a.closest('tr');
          const cells = row ? Array.from(row.querySelectorAll('td, th')) : [];
          const dateCell = cells.find(c => /\d{3}\/\d{2}\/\d{2}/.test(c.textContent || ''));
          const rocDate = dateCell?.textContent?.trim().match(/\d{3}\/\d{2}\/\d{2}/)?.[0] || '';
          return { url: a.href, date: rocDate };
        })
    );

    const tableText = await page.evaluate(() =>
      Array.from(document.querySelectorAll('table'))
        .map(t => (t as HTMLElement).innerText)
        .join('\n\n')
        .slice(0, 30000)
    );

    await page.close();
    return { links, tableText };
  } finally {
    await browser.close();
  }
}

async function fetchConferenceDocs(ticker: string): Promise<OfficialDoc[]> {
  const { links } = await submitMopsForm(`${MOPS}/mops/web/t100sb07_1`, ticker);
  const conferencePdfs = links.filter(l => /M001\.pdf|E001\.pdf/i.test(l.url));

  const docs: OfficialDoc[] = [];
  for (const link of conferencePdfs.slice(0, 3)) {
    try {
      const text = await parsePdf(link.url);
      if (text.trim().length > 200) {
        docs.push({
          type: 'conference',
          title: `法說會簡報 ${link.date}`,
          date: link.date,
          url: link.url,
          text: text.slice(0, 50000),
          chars: text.length,
        });
      }
    } catch (e: any) {
      console.error(`[mops] conference PDF failed: ${link.url} — ${e.message}`);
    }
  }
  return docs;
}

async function fetchFinancialDocs(ticker: string): Promise<OfficialDoc[]> {
  const rocYear = String(new Date().getFullYear() - 1911);
  const { links, tableText } = await submitMopsForm(
    `${MOPS}/mops/web/t164sb03`,
    ticker,
    { year: rocYear, season: '4' },
  );

  for (const link of links.slice(0, 3)) {
    try {
      const text = await parsePdf(link.url);
      if (text.trim().length > 200) {
        return [{
          type: 'financial',
          title: `財務報告 ${rocYear}`,
          date: rocYear,
          url: link.url,
          text: text.slice(0, 50000),
          chars: text.length,
        }];
      }
    } catch (e: any) {
      console.error(`[mops] financial PDF failed: ${link.url} — ${e.message}`);
    }
  }

  if (tableText.trim().length > 200) {
    return [{
      type: 'financial',
      title: `財務報告摘要 ${rocYear}`,
      date: rocYear,
      url: `${MOPS}/mops/web/t164sb03`,
      text: tableText,
      chars: tableText.length,
    }];
  }
  return [];
}

async function fetchRevenueDocs(ticker: string): Promise<OfficialDoc[]> {
  const rocYear = String(new Date().getFullYear() - 1911);
  const { tableText } = await submitMopsForm(
    `${MOPS}/mops/web/t05st10_ifrs`,
    ticker,
    { yy: rocYear },
  );

  if (tableText.trim().length < 100) return [];
  return [{
    type: 'revenue',
    title: `月營收 ${rocYear}`,
    date: rocYear,
    url: `${MOPS}/mops/web/t05st10_ifrs`,
    text: tableText,
    chars: tableText.length,
  }];
}

export async function fetchOfficialDisclosure(
  ticker: string,
  types: ('conference' | 'financial' | 'annual' | 'revenue')[] = ['conference', 'financial', 'revenue'],
): Promise<OfficialDoc[]> {
  const results: OfficialDoc[] = [];

  for (const type of types) {
    try {
      let docs: OfficialDoc[] = [];
      switch (type) {
        case 'conference': docs = await fetchConferenceDocs(ticker); break;
        case 'financial':
        case 'annual':     docs = await fetchFinancialDocs(ticker); break;
        case 'revenue':    docs = await fetchRevenueDocs(ticker); break;
      }
      results.push(...docs);
      if (docs.length) console.log(`[mops] ${type}: ${docs.length} doc(s) for ${ticker}`);
      else console.log(`[mops] ${type}: no docs found for ${ticker}`);
    } catch (e: any) {
      console.error(`[mops] ${type} failed for ${ticker}:`, e.message);
    }
  }

  return results;
}
