#!/usr/bin/env node
/**
 * Initial MAX Runner
 *
 * 以「張磊四維框架（環境→生意→組織→人）」為評分基準，對公司研究報告進行
 * 迭代深度補研究，直到品質達標（≥80/100）、plateau（2輪同分）或用完 maxRounds。
 *
 * 核心差異 vs skill-optimizer.ts：
 *  - 研究內容是加法，不做 git reset on discard
 *  - 每輪 gap-fill agent 直接寫檔案（web_search + fetch_url + write_research_section）
 *  - 使用 google/gemini-3.1-pro-preview 模型
 *
 * Usage:
 *   npx tsx src/initial-max-runner.ts --ticker NVDA
 *   npx tsx src/initial-max-runner.ts --ticker FUTU --score-only
 *   npx tsx src/initial-max-runner.ts --ticker GOOG --max-rounds 5 --tag test
 *   npx tsx src/initial-max-runner.ts --ticker MU --model minimax/minimax-m2.7
 *   npx tsx src/initial-max-runner.ts --ticker NVDA --skip-polish   # 略過結束後的順稿整理輪
 */
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { chat, type Message, type ToolDef, type ToolCall } from './llm.js';
import { scoreCompanyResearch, SCORER_MODEL, type InitialMaxScore, type InitialMaxGaps } from './initial-max-scorer.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const DEFAULT_MODEL = 'google/gemini-2.5-flash';
const DEFAULT_MAX_ROUNDS = 20;
const PASS_THRESHOLD = 95;
/** 每輪 gap-fill user 訊息附加主檔全文之上限（極長檔仍可能截斷，見訊息內說明） */
const INITIAL_MAX_MAIN_IN_USER_CHARS = 350_000;
/** read_research_file 回傳內容上限（與上項同級） */
const READ_RESEARCH_FILE_MAX_CHARS = 350_000;

const POLISH_PHASE_SYSTEM = `# Initial MAX 主檔整理輪

你是投研 Markdown 主檔的**編輯**（非研究員）。你**只有**兩個工具：讀取主檔、寫入主檔。

**絕對禁止**：任何新研究——不可網搜、不可 fetch URL、不可 Ninja API、不可 search_data_for_company、不可 read_project_file。只能依 user 訊息內已附的主檔全文，以及必要時 \`read_research_file\` 補齊截斷部分，做**編輯與重排**。

**目標**：（1）**順稿**：敘事連貫、段落銜接自然；（2）**格式**：# / ## / ### 層級一致，表格合法可讀，列表統一；（3）**去重**：刪除重複段落、重複表格或重複論點；（4）**保留事實**：數字、出處、管理層引言與**既有超連結**原則上保留；可修錯字、標點、明顯語病，**不可捏造新事實或新數字**。**連結**：勿刪除正文中的來源 URL；若某處僅文字「來源：年報」而同段或鄰近已有 URL，可改為 Markdown 連結格式（不新增新 URL）。

**寫入策略**：優先對各小節使用 \`replace_section\`——輸出**整節**順過稿（**含該節標題行**），等於**整節重寫／修正**，而非只在節尾堆字。僅在確有必要時用 \`insert_into_section\`。**禁止 append**。若開頭大段（如 IRR、結論）無法用數字錨點替換、且你已完整掌握全文，可謹慎使用 \`overwrite\` 一次寫回整檔（須零遺漏）。`;

// ── CLI args ──

function parseArgs() {
  const args: Record<string, string> = {};
  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const val = process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[++i] : 'true';
      args[key] = val;
    }
  }
  return args;
}

// ── Git helpers ──

function exec(cmd: string): string {
  return execSync(cmd, { cwd: PROJECT_ROOT, encoding: 'utf-8', timeout: 60_000 }).trim();
}

function gitShortHash(): string {
  try {
    return exec('git rev-parse --short HEAD');
  } catch {
    return 'nogit';
  }
}

function gitCommit(message: string): string {
  try {
    exec('git add -A data/companies/');
    exec(`git commit -m "${message.replace(/"/g, "'")}"`);
    return gitShortHash();
  } catch {
    return gitShortHash();
  }
}

/** 刪除該 ticker 目錄下所有 initial_max_gaps_*.json 與 initial_max_score_*.json（跑完後清理，避免累積）。 */
function cleanupTickerScoreAndGapsFiles(ticker: string): void {
  const dir = path.join(PROJECT_ROOT, 'data', 'companies', ticker);
  if (!fs.existsSync(dir)) return;
  const files = fs.readdirSync(dir);
  for (const f of files) {
    const full = path.join(dir, f);
    try {
      if ((f.startsWith('initial_max_gaps_') || f.startsWith('initial_max_score_')) && f.endsWith('.json')) {
        fs.unlinkSync(full);
      } else if (f === 'initial_max_scorecard.md') {
        fs.unlinkSync(full);
      }
    } catch (_) {}
  }
}

// ── TSV result tracking ──

interface RoundResult {
  round: number;
  commit: string;
  score: number;
  status: 'keep' | 'no_improvement' | 'crash' | 'baseline';
  description: string;
  timestamp: string;
}

function appendTsv(tsvPath: string, r: RoundResult): void {
  const line = [r.commit, r.score.toFixed(1), r.status, r.description.replace(/\t/g, ' ').replace(/\n/g, ' ').slice(0, 200)].join('\t');
  fs.appendFileSync(tsvPath, line + '\n');
}

// ── Tool implementations for gap-fill agent ──

interface SearchResult { title: string; url: string; description: string; }

async function webSearch(query: string, count = 5): Promise<string> {
  const num = Math.min(count, 10);
  const braveKey = process.env.BRAVE_SEARCH_API_KEY ?? '';
  if (braveKey && braveKey !== 'REPLACE_ME') {
    try {
      const url = new URL('https://api.search.brave.com/res/v1/web/search');
      url.searchParams.set('q', query);
      url.searchParams.set('count', String(num));
      const res = await fetch(url.toString(), {
        headers: { Accept: 'application/json', 'X-Subscription-Token': braveKey },
      });
      if (res.ok) {
        const data = await res.json() as any;
        const results = (data.web?.results ?? []).slice(0, num).map((r: any) => ({
          title: r.title ?? '', url: r.url ?? '', description: r.description ?? '',
        }));
        return JSON.stringify({ query, results });
      }
    } catch {}
  }
  // DuckDuckGo fallback
  try {
    const ddgUrl = `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`;
    const res = await fetch(ddgUrl, {
      headers: {
        Accept: 'text/html',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; rv:109.0) Gecko/20100101 Firefox/115.0',
      },
    });
    if (!res.ok) return JSON.stringify({ query, results: [] });
    const html = await res.text();
    const results: SearchResult[] = [];
    const seen = new Set<string>();
    const linkRegex = /<a[^>]+href="[^"]*uddg=([^&"]+)[^"]*"[^>]*>([^<]*)<\/a>/gi;
    let m: RegExpExecArray | null;
    while ((m = linkRegex.exec(html)) !== null && results.length < num) {
      let realUrl = '';
      try { realUrl = decodeURIComponent(m[1].replace(/\+/g, ' ')); } catch { continue; }
      if (!realUrl.startsWith('http') || seen.has(realUrl)) continue;
      seen.add(realUrl);
      const title = m[2].replace(/&amp;/g, '&').trim() || realUrl.slice(0, 60);
      results.push({ title: title.slice(0, 200), url: realUrl, description: '' });
    }
    return JSON.stringify({ query, results });
  } catch {
    return JSON.stringify({ query, results: [] });
  }
}

async function fetchUrl(url: string): Promise<string> {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; rv:109.0) Gecko/20100101 Firefox/115.0',
        Accept: 'text/html,text/plain',
      },
    });
    if (!res.ok) return JSON.stringify({ error: `HTTP ${res.status}` });
    const text = await res.text();
    // Strip most HTML tags, keep text content
    const stripped = text
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
      .replace(/\s{3,}/g, '\n\n')
      .trim()
      .slice(0, 12000);
    return JSON.stringify({ url, content: stripped });
  } catch (err: any) {
    return JSON.stringify({ error: err.message });
  }
}

async function fetchOfficialDisclosureTool(ticker: string, types?: string[]): Promise<string> {
  const { fetchOfficialDisclosure } = await import('./mops.js');
  const docs = await fetchOfficialDisclosure(ticker, types as any);
  if (!docs.length) return JSON.stringify({ status: 'no_docs', ticker });
  for (const doc of docs) {
    const safeName = doc.date.replace(/\//g, '') || 'unknown';
    const filename = `official/${doc.type}_${safeName}.md`;
    writeResearchSection(ticker, filename, `# ${doc.title}\n\n${doc.text}`, 'overwrite');
  }
  return JSON.stringify({
    status: 'fetched',
    ticker,
    docs: docs.map(d => ({ type: d.type, title: d.title, chars: d.chars })),
  });
}

/** 找到主檔中對應 section_anchor 的小節起訖（含標題行；訖為下一小節前一行）。 */
function findSectionRange(lines: string[], sectionAnchor: string): [number, number] | null {
  const anchorNum = sectionAnchor.trim();
  let sectionStart = -1;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(#{2,3})\s+(\d+\.\d+)/);
    if (m && m[2] === anchorNum) {
      sectionStart = i;
      break;
    }
    if (!m && /^#+\s+/.test(lines[i]) && lines[i].includes(anchorNum)) {
      sectionStart = i;
      break;
    }
  }
  if (sectionStart === -1) return null;
  let sectionEnd = lines.length;
  for (let j = sectionStart + 1; j < lines.length; j++) {
    if (/^#+\s+/.test(lines[j])) {
      sectionEnd = j;
      break;
    }
  }
  return [sectionStart, sectionEnd];
}

/** 將 content 插入 section_anchor 對應小節的結尾（下一小節之前）。 */
function insertIntoSection(fullPath: string, sectionAnchor: string, content: string): boolean {
  const raw = fs.readFileSync(fullPath, 'utf-8');
  const lines = raw.split(/\r?\n/);
  const range = findSectionRange(lines, sectionAnchor);
  if (!range) return false;
  const [, insertBefore] = range;
  const newBlock = content.trim();
  const before = lines.slice(0, insertBefore).join('\n').trimEnd();
  const after = lines.slice(insertBefore).join('\n');
  const out = after ? `${before}\n\n${newBlock}\n\n${after}` : `${before}\n\n${newBlock}\n`;
  fs.writeFileSync(fullPath, out);
  return true;
}

/** 以「整節替換」方式寫入：用 content 取代 section_anchor 對應的整段小節（含標題），使該節成為一段可讀、連貫的敘事。content 應含該小節標題（如 ### 1.1 TAM...）及順過後的內文。 */
function replaceSection(fullPath: string, sectionAnchor: string, content: string): boolean {
  const raw = fs.readFileSync(fullPath, 'utf-8');
  const lines = raw.split(/\r?\n/);
  const range = findSectionRange(lines, sectionAnchor);
  if (!range) return false;
  const [start, end] = range;
  const newBlock = content.trim();
  const before = lines.slice(0, start).join('\n').trimEnd();
  const after = lines.slice(end).join('\n');
  const out = after ? `${before}\n\n${newBlock}\n\n${after}` : `${before}\n\n${newBlock}\n`;
  fs.writeFileSync(fullPath, out);
  return true;
}

function writeResearchSection(
  ticker: string,
  filename: string,
  content: string,
  mode: 'append' | 'overwrite' | 'insert_into_section' | 'replace_section' = 'append',
  sectionAnchor?: string
): string {
  const dir = path.join(PROJECT_ROOT, 'data', 'companies', ticker);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const parts = filename.split('/');
  if (parts.length > 1) {
    const subDir = path.join(dir, ...parts.slice(0, -1));
    if (!fs.existsSync(subDir)) fs.mkdirSync(subDir, { recursive: true });
  }

  const fullPath = path.join(dir, filename);
  if (mode === 'overwrite') {
    fs.writeFileSync(fullPath, content);
    return JSON.stringify({ status: 'written', file: `data/companies/${ticker}/${filename}`, chars: content.length });
  }
  if ((mode === 'insert_into_section' || mode === 'replace_section') && sectionAnchor) {
    if (!fs.existsSync(fullPath)) {
      fs.writeFileSync(fullPath, content);
      return JSON.stringify({ status: 'written', file: `data/companies/${ticker}/${filename}`, chars: content.length, note: 'file was empty, wrote content' });
    }
    if (mode === 'replace_section') {
      const ok = replaceSection(fullPath, sectionAnchor, content);
      if (!ok) {
        return JSON.stringify({ error: `section_anchor "${sectionAnchor}" not found; use insert_into_section or overwrite` });
      }
      return JSON.stringify({ status: 'replaced_section', file: `data/companies/${ticker}/${filename}`, section_anchor: sectionAnchor, chars: content.length });
    }
    const ok = insertIntoSection(fullPath, sectionAnchor, content);
    if (!ok) {
      return JSON.stringify({ error: `section_anchor "${sectionAnchor}" not found in file; use append or overwrite` });
    }
    return JSON.stringify({ status: 'inserted_into_section', file: `data/companies/${ticker}/${filename}`, section_anchor: sectionAnchor, chars: content.length });
  }
  const existing = fs.existsSync(fullPath) ? fs.readFileSync(fullPath, 'utf-8') : '';
  fs.writeFileSync(fullPath, existing + (existing ? '\n\n' : '') + content);
  return JSON.stringify({ status: 'written', file: `data/companies/${ticker}/${filename}`, chars: content.length });
}

function buildMainFileFullAttachment(ticker: string): string {
  const mainFile = `${ticker}_Initial_MAX.md`;
  const mainPath = path.join(PROJECT_ROOT, 'data', 'companies', ticker, mainFile);
  if (fs.existsSync(mainPath)) {
    const raw = fs.readFileSync(mainPath, 'utf-8');
    const maxU = INITIAL_MAX_MAIN_IN_USER_CHARS;
    const truncated = raw.length > maxU;
    const shown = truncated ? raw.slice(0, maxU) : raw;
    return (
      `\n\n---\n\n## 當前 \`${mainFile}\` 原文（供對照）\n\n` +
      (truncated
        ? `_（此檔共 ${raw.length.toLocaleString()} 字元，以下僅前 ${maxU.toLocaleString()} 字元；其餘請用 \`read_research_file\` 或於本機開檔）_\n\n`
        : '') +
      `---BEGIN_${ticker}_INITIAL_MAX---\n${shown}\n---END_${ticker}_INITIAL_MAX---`
    );
  }
  return `\n\n---\n\n## 當前主檔\n\n（尚無 \`${mainFile}\`，請建立完整主檔骨架後再逐輪補強。）\n`;
}

function readResearchFile(ticker: string, filename: string): string {
  const fullPath = path.join(PROJECT_ROOT, 'data', 'companies', ticker, filename);
  if (!fs.existsSync(fullPath)) return JSON.stringify({ error: `File not found: ${filename}` });
  const content = fs.readFileSync(fullPath, 'utf-8');
  const max = READ_RESEARCH_FILE_MAX_CHARS;
  const truncated = content.length > max;
  const body = truncated ? content.slice(0, max) : content;
  return JSON.stringify({
    filename,
    content: body,
    total_chars: content.length,
    truncated,
    ...(truncated ? { note: `僅前 ${max} 字元，檔案共 ${content.length} 字元` } : {}),
  });
}

/** 列出該公司目錄下所有檔案（含 transcripts 子目錄），供 agent 判斷已有資料。 */
function listCompanyFiles(ticker: string): string {
  const dir = path.join(PROJECT_ROOT, 'data', 'companies', ticker);
  if (!fs.existsSync(dir)) return JSON.stringify({ ticker, files: [], transcripts: [], has_main_file: false });
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  let transcripts: string[] = [];
  let hasMainFile = false;
  for (const e of entries) {
    if (e.isFile()) {
      files.push(e.name);
      if (e.name === `${ticker}_Initial_MAX.md`) hasMainFile = true;
    } else if (e.isDirectory() && e.name === 'transcripts') {
      const sub = path.join(dir, 'transcripts');
      transcripts = fs.readdirSync(sub).filter((f) => f.endsWith('.md') || f.endsWith('.txt'));
    }
  }
  return JSON.stringify({ ticker, files, transcripts, has_main_file: hasMainFile });
}

/** 查詢 companies_database.json 中該 ticker 的條目（依 symbol 匹配）。 */
function queryCompaniesDb(ticker: string): string {
  const dbPath = path.join(PROJECT_ROOT, 'data', 'database', 'companies_database.json');
  if (!fs.existsSync(dbPath)) return JSON.stringify({ error: 'companies_database.json not found' });
  const raw = fs.readFileSync(dbPath, 'utf-8');
  let data: { companies?: Array<{ symbol?: string; ticker?: string; [k: string]: unknown }> };
  try {
    data = JSON.parse(raw);
  } catch {
    return JSON.stringify({ error: 'companies_database.json parse failed' });
  }
  const sym = String(ticker ?? '').trim().toUpperCase().split(/\s+/)[0];
  const company = (data.companies ?? []).find(
    (c) => (c.symbol ?? '').toUpperCase() === sym || (String(c.ticker ?? '').toUpperCase().startsWith(sym))
  );
  if (!company) return JSON.stringify({ ticker: sym, found: false, message: 'No matching company in database' });
  return JSON.stringify({ ticker: sym, found: true, company }, null, 2);
}

const NINJA_BASE = 'https://api.api-ninjas.com/v1';
function cleanTicker(t: string): string {
  return String(t ?? '').trim().toUpperCase().split(/\s+/)[0] || '';
}
async function callNinjaApi(action: string, args: Record<string, unknown>): Promise<string> {
  const key = process.env.NINJA_API_KEY ?? '';
  if (!key || key === 'REPLACE_ME') return JSON.stringify({ error: 'NINJA_API_KEY 未設定（請在專案根目錄 .env 設定）' });
  const ticker = cleanTicker(String(args.ticker ?? ''));
  if (['stockprice', 'earnings', 'earningstranscript', 'sec', 'earnings_historical'].includes(action) && !ticker && !args.cik) {
    return JSON.stringify({ error: `${action} 需要 ticker（或 cik）` });
  }
  const params: Record<string, string | number> = {};
  if (ticker) params['ticker'] = ticker;
  if (args.cik != null) params['cik'] = String(args.cik);
  if (args.year != null) params['year'] = Number(args.year);
  if (args.quarter != null) params['quarter'] = Number(args.quarter);
  if (action === 'earnings' && args.period_fy === true) params['period'] = 'fy';
  if (action === 'sec') {
    params['filing'] = (args.filing as string) || '10-K';
    params['limit'] = Math.min(10, Math.max(1, Number(args.limit) || 5));
    if (args.start) params['start'] = String(args.start);
    if (args.end) params['end'] = String(args.end);
  }
  if (action === 'earnings_historical') {
    const start = args.start_year ?? new Date().getFullYear() - 10;
    const end = args.end_year ?? new Date().getFullYear();
    const results: { year: number; data: unknown }[] = [];
    for (let y = Number(end); y >= Number(start) && results.length < 25; y--) {
      const u = new URL(NINJA_BASE + '/earnings');
      u.searchParams.set('ticker', ticker);
      u.searchParams.set('year', String(y));
      u.searchParams.set('quarter', '4');
      try {
        const res = await fetch(u.toString(), { headers: { 'X-Api-Key': key } });
        const data = res.ok ? await res.json() : null;
        results.push({ year: y, data });
      } catch (e: any) {
        results.push({ year: y, data: { error: e?.message } });
      }
      await new Promise((r) => setTimeout(r, 150));
    }
    return JSON.stringify({ ticker, start_year: start, end_year: end, by_year: results }, null, 2);
  }
  const pathMap: Record<string, string> = {
    stockprice: '/stockprice',
    earnings: '/earnings',
    earningstranscript: '/earningstranscript',
    sec: '/sec',
  };
  const p = pathMap[action];
  if (!p) return JSON.stringify({ error: `action 須為: stockprice, earnings, earningstranscript, sec, earnings_historical` });
  const url = new URL(NINJA_BASE + p);
  Object.entries(params).forEach(([k, v]) => { if (v !== undefined && v !== '') url.searchParams.set(k, String(v)); });
  try {
    const res = await fetch(url.toString(), { headers: { 'X-Api-Key': key } });
    if (!res.ok) {
      const text = await res.text();
      if (res.status === 402 || res.status === 403) return JSON.stringify({ error: '此端點為 API Ninjas Premium 限定' });
      return JSON.stringify({ error: `API ${res.status}: ${text.slice(0, 200)}` });
    }
    const data = await res.json();
    return JSON.stringify(data, null, 2);
  } catch (e: any) {
    return JSON.stringify({ error: e?.message ?? 'Request failed' });
  }
}

/** 從 companies_database 取得該 ticker 的公司名與 CEO（供搜尋關鍵字用）。 */
function getCompanyNameAndCeo(ticker: string): { name: string; ceo: string } {
  const dbPath = path.join(PROJECT_ROOT, 'data', 'database', 'companies_database.json');
  if (!fs.existsSync(dbPath)) return { name: '', ceo: '' };
  try {
    const data = JSON.parse(fs.readFileSync(dbPath, 'utf-8'));
    const sym = String(ticker).trim().toUpperCase().split(/\s+/)[0];
    const company = (data.companies ?? []).find(
      (c: any) => (c.symbol ?? '').toUpperCase() === sym || String(c.ticker ?? '').toUpperCase().startsWith(sym)
    );
    if (!company) return { name: '', ceo: '' };
    const name = (company.name ?? '').trim();
    const ceo = (company.executive?.ceo ?? '').trim().split(/\n/)[0];
    return { name, ceo };
  } catch {
    return { name: '', ceo: '' };
  }
}

/** 遞迴列出目錄下所有 .md/.txt 的相對路徑（prefix 為相對於 data 的子路徑）。 */
function listDataFilesUnder(dir: string, prefix: string, max: number): string[] {
  const out: string[] = [];
  if (!fs.existsSync(dir)) return out;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isFile() && (e.name.endsWith('.md') || e.name.endsWith('.txt'))) {
      out.push(rel);
      if (out.length >= max) return out;
    } else if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules') {
      const nextPrefix = prefix ? `${prefix}/${e.name}` : e.name;
      out.push(...listDataFilesUnder(path.join(dir, e.name), nextPrefix, max));
      if (out.length >= max) return out;
    }
  }
  return out;
}

/** 在 data/ 下搜尋與該公司相關的內容：what-happened 訪談、meeting-minutes、Knowledge 等，依 ticker/公司名/CEO 匹配。 */
function searchDataForCompany(ticker: string): string {
  const sym = String(ticker).trim().toUpperCase().split(/\s+/)[0];
  const { name: companyName, ceo: ceoName } = getCompanyNameAndCeo(ticker);
  const keywords: string[] = [sym];
  if (companyName) keywords.push(companyName);
  if (ceoName) {
    keywords.push(ceoName);
    keywords.push(ceoName.replace(/\s+/g, '')); // e.g. Sundar Pichai -> SundarPichai
  }
  const dataRoot = path.join(PROJECT_ROOT, 'data');
  const dirsToScan = [
    'content/what-happened',
    'content/meeting-minutes',
    'Knowledge/Extracted',
    'Knowledge/Translations',
  ];
  const matches: { path: string; snippet: string }[] = [];
  const seen = new Set<string>();
  const MAX_FILES = 150;
  const SNIPPET_LEN = 180;

  for (const sub of dirsToScan) {
    const dir = path.join(dataRoot, sub);
    const files = listDataFilesUnder(dir, sub, MAX_FILES);
    for (const rel of files) {
      if (seen.has(rel)) continue;
      const fullPath = path.join(dataRoot, rel);
      let content = '';
      try {
        content = fs.readFileSync(fullPath, 'utf-8').slice(0, 2500);
      } catch {
        continue;
      }
      const fileName = path.basename(rel);
      const toMatch = `${fileName} ${content}`.toLowerCase();
      const found = keywords.some((k) => k && toMatch.includes(k.toLowerCase()));
      if (found) {
        seen.add(rel);
        const firstLine = content.split(/\n/).find((l) => l.trim().length > 0) ?? '';
        matches.push({ path: `data/${rel}`, snippet: firstLine.trim().slice(0, SNIPPET_LEN) });
      }
    }
  }

  return JSON.stringify({
    ticker: sym,
    company_name: companyName || undefined,
    ceo: ceoName || undefined,
    keywords_used: keywords,
    matches,
    message: matches.length ? '可用 read_project_file(path) 讀取上述 path 的完整內容' : '未找到與該公司/CEO 相關的 data 內容',
  });
}

/** 讀取專案 data/ 下任意檔案（path 為相對專案根目錄，如 data/content/what-happened/xxx.md）。僅允許 data/ 下 .md/.txt/.json。 */
function readProjectFile(relativePath: string): string {
  const normalized = path.normalize(relativePath).replace(/\\/g, '/');
  if (!normalized.startsWith('data/') || normalized.includes('..')) {
    return JSON.stringify({ error: 'path 必須以 data/ 開頭且不得含 ..' });
  }
  const ext = path.extname(normalized).toLowerCase();
  if (!['.md', '.txt', '.json'].includes(ext)) {
    return JSON.stringify({ error: '僅支援 .md / .txt / .json' });
  }
  const fullPath = path.join(PROJECT_ROOT, normalized);
  if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) {
    return JSON.stringify({ error: `File not found: ${normalized}` });
  }
  try {
    const content = fs.readFileSync(fullPath, 'utf-8');
    return JSON.stringify({ path: normalized, content: content.slice(0, 25000), total_chars: content.length });
  } catch (e: any) {
    return JSON.stringify({ error: e?.message ?? 'Read failed' });
  }
}

// ── Gap-fill mini agent ──

const GAP_FILL_TOOLS: ToolDef[] = [
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: '搜尋網頁。最多 5 次/輪。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜尋關鍵詞' },
          count: { type: 'number', description: '結果數量（預設 5，最多 10）' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fetch_url',
      description: '抓取 URL 完整內容（適合下載逐字稿、年報頁面）。',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: '要抓取的 URL' },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_research_section',
      description:
        '寫入公司研究檔案。**主檔**：優先 **replace_section**＝整節**重寫／修正**（可刪冗、改寫句子、重排段落、合併重複），內文須含該小節標題；**不是**只能插入——若舊節需大改，直接 replace 整節。必要時才用 insert_into_section 接在節尾。禁止 append 堆文末。',
      parameters: {
        type: 'object',
        properties: {
          ticker: { type: 'string', description: '公司 ticker（大寫）' },
          filename: { type: 'string', description: '主檔為 {TICKER}_Initial_MAX.md；或 transcripts/xxx.md' },
          content: { type: 'string', description: '要寫入的 Markdown。replace_section 時為整節順過後內文（含小節標題），具可讀性、段落連貫。' },
          mode: { type: 'string', enum: ['append', 'overwrite', 'insert_into_section', 'replace_section'], description: '主檔：replace_section=整節替換並順稿；insert_into_section=插在節尾。transcripts=append。整份重寫=overwrite' },
          section_anchor: { type: 'string', description: 'mode 為 insert_into_section 或 replace_section 時必填：1.1, 1.2, 2.1, 2.2, 2.3, 2.4, 2.5, 3.1, 3.2, 3.3, 4.1' },
        },
        required: ['ticker', 'filename', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_research_file',
      description: `讀取現有研究檔案內容（最多約 ${READ_RESEARCH_FILE_MAX_CHARS.toLocaleString()} 字元；超長會標 truncated）。每輪 user 訊息通常已附主檔全文，僅在需重新對照或截斷補讀時呼叫。`,
      parameters: {
        type: 'object',
        properties: {
          ticker: { type: 'string' },
          filename: { type: 'string', description: '檔案名稱' },
        },
        required: ['ticker', 'filename'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_company_files',
      description: '列出該公司在 data/companies/{TICKER}/ 下已有檔案與 transcripts 清單，判斷缺什麼再補充。',
      parameters: {
        type: 'object',
        properties: {
          ticker: { type: 'string', description: '公司 ticker（大寫）' },
        },
        required: ['ticker'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'query_companies_db',
      description: '查詢 data/database/companies_database.json 中該 ticker 的條目（公司名、CEO、產業、財務摘要等）。',
      parameters: {
        type: 'object',
        properties: {
          ticker: { type: 'string', description: '公司 ticker（大寫）' },
        },
        required: ['ticker'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ninja_api',
      description: '呼叫 API Ninjas：財報(earnings/earnings_historical)、法說逐字稿(earningstranscript)、股價(stockprice)、SEC(sec)。需 NINJA_API_KEY。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['stockprice', 'earnings', 'earnings_historical', 'earningstranscript', 'sec'], description: 'earnings=單年季, earnings_historical=多年財報, earningstranscript=法說逐字稿' },
          ticker: { type: 'string' },
          year: { type: 'number', description: 'earnings/earningstranscript 用' },
          quarter: { type: 'number', description: 'earnings/earningstranscript 用' },
          period_fy: { type: 'boolean', description: 'earnings 時 true=全年' },
          start_year: { type: 'number', description: 'earnings_historical 起始年' },
          end_year: { type: 'number', description: 'earnings_historical 結束年' },
          filing: { type: 'string', description: 'sec 用，如 10-K, 10-Q' },
          limit: { type: 'number', description: 'sec 筆數' },
        },
        required: ['action', 'ticker'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_data_for_company',
      description: '在 data/ 下搜尋與該公司相關的內容：what-happened 訪談、meeting-minutes、Knowledge 等，依 ticker/公司名/CEO 匹配。回傳匹配的 path 與 snippet，再用 read_project_file 讀取。',
      parameters: {
        type: 'object',
        properties: {
          ticker: { type: 'string', description: '公司 ticker（大寫）' },
        },
        required: ['ticker'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_project_file',
      description: '讀取 data/ 下任意檔案。path 為相對專案根目錄，例如 data/content/what-happened/20260215_AminVahdat_Google.md。僅支援 .md/.txt/.json。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '相對專案根目錄之路徑，須以 data/ 開頭' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fetch_official_disclosure',
      description: '從公開資訊觀測站(MOPS)及 poorstock 下載官方揭露文件並解析為文字。法說會簡報元資料(conference)、財報(financial)、年報(annual)、月營收(revenue)、歷史重大訊息(announcement)、法說會AI重點摘要(earningscall，含營收/產品線/市場數據的完整法說內容)。抓到後自動存入 official/ 子目錄，可用 read_research_file 讀取。**首輪若 official/ 無資料，請優先呼叫此工具建立官方數字基準，再用官方數字覆蓋媒體整理稿。earningscall 對台股法說會內容最完整，務必抓取。**',
      parameters: {
        type: 'object',
        properties: {
          ticker: { type: 'string', description: '股票代號，例如 "7740"' },
          types: {
            type: 'array',
            items: { type: 'string', enum: ['conference', 'financial', 'annual', 'revenue', 'announcement', 'earningscall'] },
            description: '指定文件類型；不填則依預設序 conference > financial > revenue > announcement > earningscall 全部抓取',
          },
        },
        required: ['ticker'],
      },
    },
  },
];

/** 整理輪：僅讀寫主檔，禁止任何新資料蒐集 */
const POLISH_TOOLS: ToolDef[] = [
  {
    type: 'function',
    function: {
      name: 'write_research_section',
      description:
        '【整理輪】寫入 Initial MAX 主檔（檔名形如 NVDA_Initial_MAX.md）。優先 replace_section：整節**重寫**為順稿（刪重、改寫、重排），content 須含該節 Markdown 標題。必要時 overwrite 整檔（須已掌握全文、零遺漏）。禁止 append。',
      parameters: {
        type: 'object',
        properties: {
          ticker: { type: 'string', description: '公司 ticker（大寫）' },
          filename: { type: 'string', description: '主檔檔名：{TICKER}_Initial_MAX.md' },
          content: { type: 'string', description: 'replace_section 時為整節完整 Markdown（含標題）；overwrite 時為整檔全文' },
          mode: { type: 'string', enum: ['overwrite', 'insert_into_section', 'replace_section'], description: '整理輪：replace_section 為主；必要時 overwrite 整檔' },
          section_anchor: { type: 'string', description: 'replace_section / insert_into_section 時必填：1.1, 2.3 等' },
        },
        required: ['ticker', 'filename', 'content', 'mode'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_research_file',
      description: `【整理輪】讀取主檔以補齊 user 訊息截斷（最多約 ${READ_RESEARCH_FILE_MAX_CHARS.toLocaleString()} 字元）。`,
      parameters: {
        type: 'object',
        properties: {
          ticker: { type: 'string' },
          filename: { type: 'string', description: '檔案名稱' },
        },
        required: ['ticker', 'filename'],
      },
    },
  },
];

async function runGapFillAgent(
  ticker: string,
  gaps: InitialMaxGaps,
  skillContent: string,
  programPrompt: string,
  round: number,
  model: string,
  investorNote?: string,
  phase: 'gap_fill' | 'polish' = 'gap_fill',
): Promise<string> {
  const today = new Date().toISOString().slice(0, 10);
  const mainFile = `${ticker}_Initial_MAX.md`;
  const tools = phase === 'polish' ? POLISH_TOOLS : GAP_FILL_TOOLS;

  const topGaps = gaps.gaps.slice(0, 5).map((g: (typeof gaps.gaps)[number], i: number) =>
    `${i + 1}. 【${g.dimension}】${g.item}：現況 ${g.current}，目標 ${g.target}，缺 ${g.shortfall} 分`,
  ).join('\n');

  const investorSection = investorNote && investorNote.trim().length > 0
    ? `\n\n### 投資人關注重點（為什麼想看這家公司）\n${investorNote.trim()}`
    : '';

  let taskMessage: string;
  if (phase === 'polish') {
    taskMessage = `## ${ticker} Initial MAX **整理輪**（順稿／格式／去重，${today}）

**背景**：研究迭代已停止。本輪**只做編輯**，不網搜、不 API、不抓新訪談。主檔全文見本訊息末尾。

### 必做
1. **順稿**：段落銜接自然、刪除重複論點與重複表格／列表。
2. **格式**：標題層級一致、表格合法、列表統一、空白行適度。
3. **修正**：錯字、標點、明顯語病；**保留**數字、出處、引言與連結；不新增事實。
4. **寫入**：優先對需整理的小節使用 \`replace_section\`（整節輸出＝**可完全改寫該節**，含標題）。**禁止 append**。

若主檔在訊息內被截斷，用 \`read_research_file\` 讀 \`${mainFile}\`。

**輸出格式**（工具完成後）：
{"description": "polished 1.1–2.3, fixed ## headings, deduped 4.1", "files_written": ["${mainFile}"], "interviews_added": 0, "dimensions_addressed": ["polish"]}`;
  } else {
    taskMessage = `## ${ticker} 研究缺口補充任務（第 ${round} 輪，${today}）

**當前分數**：${gaps.score}/100（目標 **≥95/100**，且各維度達最低分、2.5 DCF 必達）

### 優先缺口（依缺分高低排列）：
${topGaps}

### 任務指示：
- **主檔對照**：本訊息**末尾已附**當前 \`${mainFile}\` 全文（或前 ${INITIAL_MAX_MAIN_IN_USER_CHARS.toLocaleString()} 字元）。**撰寫前務必對照**：只補缺口，**勿重複**既有段落、表格、已引用之訪談與數字。
- **整節修正與重寫**：優先 \`replace_section\`——對該小節輸出**整節**內容（含標題），可**刪冗、改寫、重排、合併**舊文與新補資料成順稿；**不是**只能往節尾插入。僅在確實要附加在節尾時才用 \`insert_into_section\`。
- **工具依需求呼叫，勿每輪固定全叫**：僅在**本輪要補的缺口**需要時才呼叫。例如：要補「人」或 CEO 原話時再 \`search_data_for_company\` 或 \`read_project_file\`；要補財報時再 \`ninja_api(earnings_historical)\`。主檔已附於本訊息時**不必**為了對照而再 \`read_research_file\`；若訊息內主檔被截斷或需二次確認再呼叫。勿每輪一開頭就呼叫 list_company_files、query_companies_db、search_data_for_company。
1. 依**優先缺口**決定本輪補哪 1～2 個維度；缺財報→ninja_api(earnings_historical)；缺法說→ninja_api(earningstranscript) 或 fetch_url；缺管理層原話→可 search_data_for_company 再 read_project_file 摘錄。
2. web_search 最多 5 次，留給真正需要搜尋的缺口。
3. 寫入主檔 \`${mainFile}\` 時：對照文末全文後，以 \`replace_section\`（整節重寫／修正）為主，\`insert_into_section\` 為輔；禁止 append 堆文末。
4. **資料來源連結（本輪必守）**：凡本輪新增／改寫的數據、表格註、監管與市場敘述、訪談與財報引用，**須附可點擊 \`https://\` 連結**（Markdown 連結或裸 URL）；**禁止**只寫「10-K」「年報」「某機構報告」等名稱而無 URL。訪談用原文 URL；年報用 SEC／IR 文件連結；已下載逐字稿可連 \`transcripts/檔名\`。
5. 地理/業務分部須標年報或法說出處（含連結）；每子點至少 5 則管理層原話（引號+出處+日期+訪談／逐字稿 **URL**）。
6. 完成後輸出 JSON summary（見下方格式）${investorSection}

**輸出格式**（在所有工具呼叫完成後）：
{"description": "filled X interviews, added geographic revenue from 10-K, ...", "files_written": ["${mainFile}", "transcripts/..."], "interviews_added": 數字, "dimensions_addressed": [...]}`;
  }

  const userContent = taskMessage + buildMainFileFullAttachment(ticker);

  const MAX_SKILL_CHARS = 14000;
  const MAX_PROGRAM_CHARS = 3500;
  let systemContent: string;
  if (phase === 'polish') {
    systemContent = POLISH_PHASE_SYSTEM;
  } else {
    const skillTrimmed = skillContent.length > MAX_SKILL_CHARS ? skillContent.slice(0, MAX_SKILL_CHARS) + '\n\n...(SKILL 後段省略，依章節結構與工具說明操作)' : skillContent;
    const programTrimmed = programPrompt.length > MAX_PROGRAM_CHARS ? programPrompt.slice(0, MAX_PROGRAM_CHARS) + '\n\n...(其餘見 SKILL)' : programPrompt;
    systemContent = `${programTrimmed}\n\n---\n\n## 研究 SKILL 指引\n\n${skillTrimmed}`;
  }

  const messages: Message[] = [
    { role: 'system', content: systemContent },
    { role: 'user', content: userContent },
  ];

  let searchCalls = 0;
  const MAX_SEARCH = 5;
  const MAX_TOOL_ROUNDS = 20;
  let finalResponse = '';

  // Polish 階段防 loop：每個 section_anchor 只允許 replace 一次。
  // 否則模型會反覆 replace_section 同一節（觀察到單節被改寫 15 次），徒增成本與損壞風險。
  // normalize：剝除 # 前綴與標題中文字，只保留純節號（"### 2.1 商業模式" → "2.1"）
  // 防止模型用不同格式的同一節號繞過 guard（實測：2.1 / 2.1 商業模式 / ### 2.1 商業模式）。
  function normalizeAnchor(a: string): string {
    const stripped = a.replace(/^#+\s*/, '').trim();
    const m = stripped.match(/^[\d.]+/);
    return m ? m[0] : stripped.toLowerCase();
  }
  const polishedAnchors = new Set<string>();

  for (let toolRound = 0; toolRound < MAX_TOOL_ROUNDS; toolRound++) {
    // noFreeTier：Google 模型 429 時跳過 OpenRouter 免費爛模型（Gemma/Nemotron），
    // 直接走付費 flash。研究品質敏感，免費模型回傳「可解析但垃圾」比失敗更糟。
    const response = await chat(messages, { model, tools, maxTokens: 16384, noFreeTier: true });

    if (response.content) finalResponse = response.content;
    if (response.toolCalls.length === 0) break;

    messages.push({
      role: 'assistant',
      content: response.content ?? '',
      tool_calls: response.toolCalls,
    });

    for (const tc of response.toolCalls) {
      let args: Record<string, any> = {};
      try { args = JSON.parse(tc.function.arguments); } catch {}
      let result: string;

      switch (tc.function.name) {
        case 'web_search':
          if (searchCalls >= MAX_SEARCH) {
            result = JSON.stringify({ error: '搜尋預算耗盡（最多5次）' });
          } else {
            searchCalls++;
            console.log(`  [search ${searchCalls}/${MAX_SEARCH}] ${args.query?.slice(0, 60)}...`);
            result = await webSearch(args.query ?? '', args.count ?? 5);
          }
          break;
        case 'fetch_url':
          console.log(`  [fetch] ${args.url?.slice(0, 80)}...`);
          result = await fetchUrl(args.url ?? '');
          break;
        case 'write_research_section': {
          const wMode = (args.mode as 'append' | 'overwrite' | 'insert_into_section' | 'replace_section') ?? 'append';
          const wAnchor = args.section_anchor as string | undefined;
          // Polish 防 loop：同一節已 replace 過就拒絕，要求模型換節或結束。
          // 使用 normalizeAnchor 避免模型以不同格式（"2.1" vs "### 2.1 商業模式"）繞過 guard。
          const wAnchorKey = wAnchor ? normalizeAnchor(wAnchor) : undefined;
          if (phase === 'polish' && wMode === 'replace_section' && wAnchorKey && polishedAnchors.has(wAnchorKey)) {
            console.log(`  [write] (skipped) ${wAnchor} 已順稿過一次，拒絕重複 replace`);
            result = JSON.stringify({ error: `section "${wAnchor}" 本輪已順稿完成，請改順其他小節或直接輸出 JSON summary 結束。` });
            break;
          }
          console.log(`  [write] ${args.ticker}/${args.filename} (${(args.content ?? '').length} chars)${wMode === 'replace_section' || wMode === 'insert_into_section' ? ` → ${wMode} ${wAnchor}` : ''}`);
          result = writeResearchSection(
            args.ticker ?? ticker,
            args.filename ?? '',
            args.content ?? '',
            wMode,
            wAnchor
          );
          if (phase === 'polish' && wMode === 'replace_section' && wAnchorKey) polishedAnchors.add(wAnchorKey);
          break;
        }
        case 'read_research_file':
          result = readResearchFile(args.ticker ?? ticker, args.filename ?? '');
          break;
        case 'list_company_files':
          console.log(`  [list] ${args.ticker ?? ticker}`);
          result = listCompanyFiles(args.ticker ?? ticker);
          break;
        case 'query_companies_db':
          console.log(`  [db] ${args.ticker ?? ticker}`);
          result = queryCompaniesDb(args.ticker ?? ticker);
          break;
        case 'ninja_api':
          console.log(`  [ninja] ${args.action} ${args.ticker ?? ''}`);
          result = await callNinjaApi(String(args.action ?? ''), args);
          break;
        case 'search_data_for_company':
          console.log(`  [search_data] ${args.ticker ?? ticker}`);
          result = searchDataForCompany(args.ticker ?? ticker);
          break;
        case 'read_project_file':
          console.log(`  [read_project] ${args.path?.slice(0, 60)}...`);
          result = readProjectFile(args.path ?? '');
          break;
        case 'fetch_official_disclosure':
          console.log(`  [mops] ${args.ticker ?? ticker} types=${JSON.stringify(args.types ?? [])}`);
          result = await fetchOfficialDisclosureTool(args.ticker ?? ticker, args.types);
          break;
        default:
          result = JSON.stringify({ error: `Unknown tool: ${tc.function.name}` });
      }

      const maxToolChars =
        tc.function.name === 'read_research_file' ? READ_RESEARCH_FILE_MAX_CHARS + 4096 : 12000;
      const contentToPush =
        result.length > maxToolChars
          ? result.slice(0, maxToolChars) + '\n\n...(內容已截斷，僅顯示前 ' + maxToolChars + ' 字元)'
          : result;
      messages.push({ role: 'tool', content: contentToPush, tool_call_id: tc.id });
    }
  }

  return finalResponse || '(no response)';
}

// ── Main loop ──

async function main() {
  const args = parseArgs();
  const ticker = (args.ticker ?? args.t ?? '').toUpperCase();
  if (!ticker) {
    console.error('Usage: npx tsx src/initial-max-runner.ts --ticker NVDA [--max-rounds 20] [--model MODEL] [--score-only] [--skip-polish] [--tag label] [--skill tw-stock]');
    process.exit(1);
  }

  const maxRounds = parseInt(args['max-rounds'] ?? args['rounds'] ?? String(DEFAULT_MAX_ROUNDS), 10);
  const noPlateau = args['no-plateau'] === 'true';
  const scoreOnly = args['score-only'] === 'true';
  const skipPolish = args['skip-polish'] === 'true';
  const force = args['force'] === 'true';
  const model = args.model ?? DEFAULT_MODEL;
  const market = args.market ?? 'US';
  const investorNote = args.why ?? args.note ?? '';
  const tag = args.tag ?? new Date().toISOString().slice(5, 10).replace('-', '');
  const skillName = args.skill ?? args.market?.toLowerCase() === 'tw' ? 'tw-stock' : 'initial-max';

  // 燒錢防呆：非 Google 模型（Claude/GPT 等）走 OpenRouter 付費，且無免費額度、
  // 無自動快取，整批研究易意外燒掉數美元。需 --force 明確放行。
  const isGoogleModelSelected = model.startsWith('google/') || model.startsWith('gemini-');
  if (!isGoogleModelSelected && !force) {
    console.error(`\n✗ 已選用非 Google 付費模型「${model}」。`);
    console.error(`  此類模型走 OpenRouter 付費、無免費額度、無 prompt caching，整批研究易燒掉數美元。`);
    console.error(`  預設模型 ${DEFAULT_MODEL} 走 Google 已付費 key，月成本極低。`);
    console.error(`  若確定要用付費模型，請加 --force 放行。\n`);
    process.exit(1);
  }

  console.log('╔══════════════════════════════════════╗');
  console.log('║       Initial MAX Runner             ║');
  console.log('╚══════════════════════════════════════╝');
  console.log(`Ticker:     ${ticker}`);
  console.log(`Max rounds: ${maxRounds}`);
  console.log(`Model:      ${model}`);
  console.log(`Skill:      ${skillName}`);
  console.log(`Score only: ${scoreOnly}`);
  if (investorNote) {
    console.log(`Why:        ${investorNote}`);
  }
  console.log(`Tag:        initial-max-${ticker}-${tag}`);
  console.log();

  // Setup TSV tracking
  const resultsDir = path.join(PROJECT_ROOT, 'results');
  if (!fs.existsSync(resultsDir)) fs.mkdirSync(resultsDir, { recursive: true });
  const tsvPath = path.join(resultsDir, `initial-max-${ticker.toLowerCase()}-${tag}.tsv`);
  if (!fs.existsSync(tsvPath)) {
    fs.writeFileSync(tsvPath, 'commit\tscore\tstatus\tdescription\n');
  }

  // Load SKILL and program prompt
  const skillPath = path.join(PROJECT_ROOT, 'skills', skillName, 'SKILL.md');
  const programPath = path.join(__dirname, 'program-initial-max.md');
  if (!fs.existsSync(skillPath)) {
    console.error(`SKILL not found: ${skillPath}`);
    console.error(`Available skills: ${fs.readdirSync(path.join(PROJECT_ROOT, 'skills')).join(', ')}`);
    process.exit(1);
  }
  const skillContent = fs.readFileSync(skillPath, 'utf-8');
  const programPrompt = fs.existsSync(programPath) ? fs.readFileSync(programPath, 'utf-8') : '';

  // Baseline score
  console.log('\n═══ Baseline Scoring ═══');
  // 評分用強模型 SCORER_MODEL，與研究用的 model(Flash) 脫鉤，確保評分穩定。
  const { score: baselineScore, gaps: baselineGaps } = await scoreCompanyResearch(ticker, 0, SCORER_MODEL, market);
  const baselineResult: RoundResult = {
    round: 0,
    commit: gitShortHash(),
    score: baselineScore.total,
    status: 'baseline',
    description: `baseline score ${baselineScore.total}/100`,
    timestamp: new Date().toISOString(),
  };
  appendTsv(tsvPath, baselineResult);

  if (scoreOnly) {
    console.log(`\nScore-only mode. Final score: ${baselineScore.total}/100`);
    cleanupTickerScoreAndGapsFiles(ticker);
    return;
  }

  if (baselineScore.passThreshold && !force) {
    console.log(`\n✓ Already at ${baselineScore.total}/100 — threshold met. No further research needed.`);
    console.log(`  (Use --force to continue researching anyway)`);
    cleanupTickerScoreAndGapsFiles(ticker);
    return;
  }
  if (baselineScore.passThreshold && force) {
    console.log(`\n→ Threshold already met (${baselineScore.total}/100) but --force set — continuing research.`);
  }

  // Main loop
  const history: RoundResult[] = [baselineResult];
  let prevScore = baselineScore.total;
  let plateauCount = 0;

  for (let round = 1; round <= maxRounds; round++) {
    console.log(`\n═══ Round ${round}/${maxRounds} (current: ${prevScore}/100) ═══`);
    const roundStart = Date.now();

    try {
      // Get latest gaps (from previous round)
      const gapsPath = path.join(PROJECT_ROOT, 'data', 'companies', ticker, `initial_max_gaps_${round - 1}.json`);
      let gaps: InitialMaxGaps = baselineGaps;
      if (fs.existsSync(gapsPath)) {
        gaps = JSON.parse(fs.readFileSync(gapsPath, 'utf-8'));
      }

      console.log('Running gap-fill agent...');
      const agentResponse = await runGapFillAgent(ticker, gaps, skillContent, programPrompt, round, model, investorNote);

      // Parse agent summary
      let description = `round ${round} gap-fill`;
      try {
        const jsonMatch = agentResponse.match(/\{[\s\S]*"description"[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          description = parsed.description ?? description;
        }
      } catch {}
      console.log(`Agent summary: ${description}`);

      // Score new state
      console.log('Scoring...');
      const { score: newScore } = await scoreCompanyResearch(ticker, round, SCORER_MODEL, market);
      const delta = newScore.total - prevScore;
      console.log(`Score: ${newScore.total}/100 (${delta >= 0 ? '+' : ''}${delta} from ${prevScore})`);

      // Commit (always — research is additive)
      const commitMsg = `initial-max r${round}: ${description.slice(0, 60)} — score ${newScore.total}/100`;
      const commitHash = gitCommit(commitMsg);

      const status: RoundResult['status'] = delta > 0 ? 'keep' : 'no_improvement';
      const result: RoundResult = {
        round, commit: commitHash, score: newScore.total, status,
        description, timestamp: new Date().toISOString(),
      };
      history.push(result);
      appendTsv(tsvPath, result);

      if (delta > 0) {
        console.log(`✓ IMPROVED by +${delta}`);
        plateauCount = 0;
      } else {
        console.log(`→ No improvement (plateau count: ${plateauCount + 1}/2)`);
        plateauCount++;
      }

      prevScore = newScore.total;

      // Stop conditions
      if (newScore.passThreshold) {
        console.log(`\n✓ TARGET REACHED: ${newScore.total}/100 ≥ ${PASS_THRESHOLD}`);
        break;
      }
      if (plateauCount >= 2 && !noPlateau) {
        console.log(`\n⚠ PLATEAU DETECTED: 2 consecutive rounds with no improvement. Stopping.`);
        break;
      }
      if (plateauCount >= 2 && noPlateau) {
        console.log(`→ Plateau reached but --no-plateau set, continuing…`);
      }

      const elapsed = ((Date.now() - roundStart) / 1000).toFixed(1);
      console.log(`Round ${round} done in ${elapsed}s`);

    } catch (err: any) {
      console.error(`Round ${round} CRASH: ${err.message}`);
      const result: RoundResult = {
        round, commit: gitShortHash(), score: prevScore, status: 'crash',
        description: err.message.slice(0, 100), timestamp: new Date().toISOString(),
      };
      history.push(result);
      appendTsv(tsvPath, result);
    }
  }

  const polishRoundId = maxRounds + 1;
  const mainFilePath = path.join(PROJECT_ROOT, 'data', 'companies', ticker, `${ticker}_Initial_MAX.md`);
  const ranAtLeastOneResearchRound = history.some((h) => h.round >= 1);

  if (!skipPolish && fs.existsSync(mainFilePath) && ranAtLeastOneResearchRound) {
    console.log('\n═══ Polish pass（主檔順稿／格式整理，無新研究）═══');
    try {
      const polishGaps: InitialMaxGaps = { round: polishRoundId, score: prevScore, gaps: [] };
      const polishResp = await runGapFillAgent(
        ticker,
        polishGaps,
        skillContent,
        programPrompt,
        polishRoundId,
        model,
        investorNote,
        'polish',
      );
      let polishDesc = 'polish pass';
      try {
        const jsonMatch = polishResp.match(/\{[\s\S]*"description"[\s\S]*\}/);
        if (jsonMatch) polishDesc = JSON.parse(jsonMatch[0]).description ?? polishDesc;
      } catch {}
      console.log(`Polish summary: ${polishDesc}`);
      console.log('Scoring after polish...');
      const { score: afterPolish } = await scoreCompanyResearch(ticker, polishRoundId, SCORER_MODEL, market);
      console.log(`Score after polish: ${afterPolish.total}/100`);
      const commitHash = gitCommit(`initial-max polish: ${polishDesc.slice(0, 55)} — score ${afterPolish.total}/100`);
      history.push({
        round: polishRoundId,
        commit: commitHash,
        score: afterPolish.total,
        status: 'keep',
        description: polishDesc,
        timestamp: new Date().toISOString(),
      });
      appendTsv(tsvPath, history[history.length - 1]!);
      prevScore = afterPolish.total;
    } catch (err: any) {
      console.error(`Polish pass CRASH: ${err.message}`);
      const crashResult: RoundResult = {
        round: polishRoundId,
        commit: gitShortHash(),
        score: prevScore,
        status: 'crash',
        description: `polish: ${err.message.slice(0, 80)}`,
        timestamp: new Date().toISOString(),
      };
      history.push(crashResult);
      appendTsv(tsvPath, crashResult);
    }
  } else if (skipPolish && ranAtLeastOneResearchRound) {
    console.log('\n（略過整理輪：--skip-polish）');
  } else if (!skipPolish && ranAtLeastOneResearchRound && !fs.existsSync(mainFilePath)) {
    console.log('\n（略過整理輪：主檔不存在）');
  }

  // Final summary
  const finalScore = history[history.length - 1].score;
  const kept = history.filter(r => r.status === 'keep').length;
  const noImprove = history.filter(r => r.status === 'no_improvement').length;
  const crashed = history.filter(r => r.status === 'crash').length;

  console.log('\n╔══════════════════════════════════════╗');
  console.log(`║  Initial MAX Complete: ${ticker.padEnd(6)} ${String(finalScore).padStart(3)}/100     ║`);
  console.log('╚══════════════════════════════════════╝');
  console.log(`Rounds: ${history.length - 1} | Improved: ${kept} | No-improvement: ${noImprove} | Crashed: ${crashed}`);
  console.log(`Score: ${baselineScore.total} → ${finalScore} (+${finalScore - baselineScore.total})`);
  console.log(`Status: ${finalScore >= PASS_THRESHOLD ? '✓ PASSED' : '✗ NOT YET (more rounds needed)'}`);
  console.log(`Results: ${tsvPath}`);
  cleanupTickerScoreAndGapsFiles(ticker);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
