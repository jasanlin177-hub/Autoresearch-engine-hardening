/**
 * pdf-prefetch.ts
 *
 * 問題：CLI agent（Claude/Codex）自行抓取公司官網年報 PDF 時，常被目標站台以
 * 403 擋下（伺服器擋掉沒有瀏覽器 User-Agent 的請求）。agent 重試多輪仍抓不到，
 * 導致同一個缺口反覆卡住、寫入「查無法核」的記錄，拖累分數。
 *
 * 解法：runner（本機 Node 環境）比 CLI agent 的沙盒更容易帶正確 UA 下載成功。
 * 掃描主檔中已出現的 .pdf 連結，本機下載＋解析文字，快取後附加進下一輪 prompt，
 * 讓 agent 直接引用文字，不需再自行抓取。
 */
import * as fs from 'fs';
import * as path from 'path';
import { PDFParse } from 'pdf-parse';

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const MAX_PDFS_PER_ROUND = 3;
const MAX_TEXT_CHARS = 20_000;
const FETCH_TIMEOUT_MS = 20_000;

/** 從主檔文字中找出所有唯一的 .pdf 連結（含查詢字串），最多取前 N 個。 */
function extractPdfUrls(mainFileContent: string): string[] {
  const matches = mainFileContent.match(/https?:\/\/[^\s)\]"']+\.pdf(?:[^\s)\]"']*)?/gi) ?? [];
  return Array.from(new Set(matches)).slice(0, MAX_PDFS_PER_ROUND);
}

function cacheKey(url: string): string {
  return Buffer.from(url).toString('base64url').slice(0, 60) + '.txt';
}

/** 下載並解析單一 PDF；失敗回傳 null（不阻塞整體流程）。 */
async function fetchAndParsePdf(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': BROWSER_UA },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    const parser = new PDFParse({ data: buf });
    const result = await parser.getText();
    return result.text;
  } catch {
    return null;
  }
}

/**
 * 掃描主檔既有 PDF 連結，本機預先下載並解析（含快取），
 * 回傳可直接附加到 prompt 的文字區塊；沒有可用 PDF 時回傳空字串。
 */
export async function buildPdfPrefetchAttachment(
  ticker: string,
  mainFileContent: string,
  projectRoot: string,
): Promise<string> {
  const urls = extractPdfUrls(mainFileContent);
  if (urls.length === 0) return '';

  const cacheDir = path.join(projectRoot, 'data', 'companies', ticker, 'pdf_cache');
  fs.mkdirSync(cacheDir, { recursive: true });

  const blocks: string[] = [];
  for (const url of urls) {
    const cachePath = path.join(cacheDir, cacheKey(url));
    let text: string | null;
    if (fs.existsSync(cachePath)) {
      text = fs.readFileSync(cachePath, 'utf-8');
    } else {
      text = await fetchAndParsePdf(url);
      if (text) fs.writeFileSync(cachePath, text, 'utf-8');
    }
    if (!text) continue;
    const shown = text.length > MAX_TEXT_CHARS ? text.slice(0, MAX_TEXT_CHARS) + '\n...(截斷)' : text;
    blocks.push(`### 已預先下載並解析：${url}\n\n${shown}`);
  }

  if (blocks.length === 0) return '';
  return (
    `\n\n---\n\n## 預先下載的 PDF 全文（runner 已本機下載＋解析，請直接引用此處內容，不需再自行抓取這些連結）\n\n` +
    blocks.join('\n\n---\n\n')
  );
}
