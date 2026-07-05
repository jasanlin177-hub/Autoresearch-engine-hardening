/**
 * claude-cli-runner.ts
 * 以 Claude Code CLI (`claude -p`) 取代 Gemini API 執行 gap-fill agent。
 * Claude 在本機直接呼叫 Read/Write/Edit/Bash/WebSearch，研究品質由 Claude Sonnet/Opus 保證。
 */

import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { buildPdfPrefetchAttachment } from './pdf-prefetch.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');

export interface InitialMaxGaps {
  round: number;
  score: number;
  gaps: Array<{
    dimension: string;
    item: string;
    current: string | number;
    target: string | number;
    shortfall: string | number;
  }>;
}

interface CliResult {
  response: string;
  wroteToMainFile: boolean;
  costUsd?: number;
}

/** 取得主檔的最後修改時間（mtime），用於判斷本輪是否有寫入。 */
function getMainFileMtime(ticker: string): number {
  const p = path.join(PROJECT_ROOT, 'data', 'companies', ticker, `${ticker}_Initial_MAX.md`);
  try { return fs.statSync(p).mtimeMs; } catch { return 0; }
}

/** 讀取主檔全文（供附在 prompt 末尾供 Claude 對照）。 */
function readMainFile(ticker: string): string {
  const mainFile = `${ticker}_Initial_MAX.md`;
  const p = path.join(PROJECT_ROOT, 'data', 'companies', ticker, mainFile);
  if (!fs.existsSync(p)) {
    return `\n\n---\n\n## 當前主檔\n\n（尚無 \`${mainFile}\`，請建立完整主檔骨架後再逐輪補強。）\n`;
  }
  const raw = fs.readFileSync(p, 'utf-8');
  const MAX = 60_000;
  const truncated = raw.length > MAX;
  const shown = truncated ? raw.slice(0, MAX) : raw;
  return (
    `\n\n---\n\n## 當前 \`${mainFile}\` 原文（供對照）\n\n` +
    (truncated ? `_（此檔共 ${raw.length.toLocaleString()} 字元，以下僅前 ${MAX.toLocaleString()} 字元）_\n\n` : '') +
    `---BEGIN_${ticker}_INITIAL_MAX---\n${shown}\n---END_${ticker}_INITIAL_MAX---`
  );
}

/** 組裝 gap-fill prompt（給 Claude CLI 的完整指令）。若主檔已含 PDF 連結，本機預先下載解析後一併附上。 */
async function buildGapFillPrompt(
  ticker: string,
  gaps: InitialMaxGaps,
  round: number,
  noWriteWarning: boolean,
): Promise<string> {
  const today = new Date().toISOString().slice(0, 10);
  const mainFile = `${ticker}_Initial_MAX.md`;
  const mainFilePath = path.join(PROJECT_ROOT, 'data', 'companies', ticker, mainFile).replace(/\\/g, '/');
  const topGaps = gaps.gaps.slice(0, 5).map((g, i) =>
    `${i + 1}. 【${g.dimension}】${g.item}：現況 ${g.current}，目標 ${g.target}，缺 ${g.shortfall} 分`,
  ).join('\n');

  const noWriteAlert = noWriteWarning
    ? `\n> ⚠ **上輪未寫入任何內容到主檔。** 本輪取得資料後必須立即寫入，不得延後。\n`
    : '';

  const mainFileText = readMainFile(ticker);
  const pdfAttachment = await buildPdfPrefetchAttachment(ticker, mainFileText, PROJECT_ROOT);

  const prompt = `你是台股深度研究的投研編輯。你的任務是補強公司研究主檔的缺口。

## ${ticker} 研究缺口補充任務（第 ${round} 輪，${today}）${noWriteAlert}

**當前分數**：${gaps.score}/100（目標 ≥95/100）

### 優先缺口（依缺分高低排列）：
${topGaps}

### 工作目標：
主檔路徑：\`${mainFilePath}\`

### 任務指示：
1. 先用 Read 工具讀取主檔，了解現有內容，避免重複。
2. 依優先缺口決定本輪補哪 1～2 個維度：
   - 缺財報數據 → 用 WebSearch 搜尋或 Bash 呼叫 curl 抓 MOPS 財報
   - 缺管理層原話 → WebSearch 搜尋 CEO 訪談
   - 缺產業 TAM → WebSearch 搜尋市場規模報告
3. WebSearch 最多 5 次，只用於真正需要補的缺口。
4. 取得資料後，**立即**用 Edit 或 Write 工具將整理後的內容寫入主檔對應章節。
   - 寫入時保留既有內容，只補缺口章節（# 標題層級請對齊主檔）
   - 所有數據、引用必須附 https:// 來源連結
5. ⚠ **強制規定**：本輪必須至少執行一次 Write 或 Edit 寫入主檔，不得只研究不寫入。
6. 若下方已附「預先下載的 PDF 全文」，直接引用其內容，**不要**再自行嘗試抓取同一個 PDF 連結（該站台會擋掉非瀏覽器請求）。
7. ⚠ **禁止把過程紀錄寫進主檔正文**：不得出現「第 N 輪補強」「本輪新增」「更新後…覆蓋率由 X 提升至 Y」這類 changelog／meta 敘述。主檔只留**最終研究結論**（事實、數字、引言、來源連結）；你這輪做了什麼一律寫進最後那行 JSON 的 description，不要寫進正文。

### 完成後輸出 JSON（最後一行）：
{"description": "補充了哪些內容（過程紀錄只寫這裡，不寫主檔正文）", "sections_written": ["1.1", "2.2"], "interviews_added": 數字}
${mainFileText}${pdfAttachment}`;

  return prompt;
}

/** 組裝 polish prompt。 */
function buildPolishPrompt(ticker: string, score: number): string {
  const today = new Date().toISOString().slice(0, 10);
  const mainFilePath = path.join(PROJECT_ROOT, 'data', 'companies', ticker, `${ticker}_Initial_MAX.md`).replace(/\\/g, '/');

  return `你是台股深度研究的投研編輯。本輪只做整理，不研究新內容。

## ${ticker} 研究主檔整理輪（${today}，分數 ${score}/100）

主檔路徑：\`${mainFilePath}\`

### 必做：
1. Read 主檔全文
2. 刪除重複段落、重複表格、重複引言
3. 段落銜接順暢、標題層級一致、表格格式合法
4. 修正錯字與語病，保留所有數字、連結、出處
5. 用 Edit 或 Write 寫回主檔（必須執行，不可只讀不寫）

### 完成後輸出 JSON（最後一行）：
{"description": "polish 整理摘要", "sections_polished": ["1.1", "4.1"]}`;
}

/** 執行 `claude -p` subprocess，回傳結果。gap-fill 深度研究一輪可能需要數分鐘。 */
async function spawnClaude(prompt: string, timeoutMs = 900_000): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const args = [
      '-p', prompt,
      '--output-format', 'json',
      '--allowedTools', 'Read,Write,Edit,Bash,WebSearch,Glob,Grep',
    ];

    const proc = spawn('claude', args, {
      cwd: PROJECT_ROOT,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error(`claude CLI timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0 && !stdout) {
        reject(new Error(`claude CLI exited ${code}: ${stderr.slice(0, 200)}`));
        return;
      }
      try {
        const parsed = JSON.parse(stdout.trim());
        if (parsed.is_error) {
          reject(new Error(`claude CLI error: ${parsed.result ?? stderr}`));
          return;
        }
        resolve({
          response: parsed.result ?? '',
          wroteToMainFile: false, // 由 caller 用 mtime 判斷
          costUsd: parsed.total_cost_usd,
        });
      } catch {
        // stdout 不是 JSON（罕見），視為純文字回應
        resolve({ response: stdout.trim(), wroteToMainFile: false });
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`Failed to spawn claude: ${err.message}`));
    });
  });
}

/**
 * 以 Claude Code CLI 執行一輪 gap-fill 研究。
 * 介面與 runGapFillAgent() 相容。
 */
export async function runClaudeCliAgent(
  ticker: string,
  gaps: InitialMaxGaps,
  round: number,
  phase: 'gap_fill' | 'polish' = 'gap_fill',
  noWriteWarning = false,
): Promise<{ response: string; wroteToMainFile: boolean }> {
  const mtimeBefore = getMainFileMtime(ticker);

  const prompt = phase === 'polish'
    ? buildPolishPrompt(ticker, gaps.score)
    : await buildGapFillPrompt(ticker, gaps, round, noWriteWarning);

  const result = await spawnClaude(prompt);

  const mtimeAfter = getMainFileMtime(ticker);
  const wroteToMainFile = mtimeAfter > mtimeBefore;

  if (result.costUsd !== undefined) {
    console.log(`  [claude-cli] cost $${result.costUsd.toFixed(4)} USD`);
  }

  return { response: result.response, wroteToMainFile };
}
