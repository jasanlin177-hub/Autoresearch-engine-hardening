/**
 * codex-cli-runner.ts
 * 以 OpenAI Codex CLI (`codex exec --json`) 執行 gap-fill agent。
 * 吃 ChatGPT 訂閱額度（auth_mode: chatgpt），不走 API 計費。
 *
 * 與 claude-cli-runner.ts 介面相容，差異僅在：
 *  - spawn `codex exec` 而非 `claude -p`
 *  - 輸出為 JSONL 串流（逐行解析），非單一 JSON
 */

import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { buildPdfPrefetchAttachment } from './pdf-prefetch.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');

/**
 * 主檔章節結構（固定 1.1～4.2 編號，對應 scorer 的 REQUIRED_SECTIONS）。
 * API 引擎（runGapFillAgent）靠 SKILL.md system prompt 強制此結構；
 * CLI 引擎沒有走 SKILL.md，若不內嵌這份清單，agent 首輪建骨架時會自創編號，
 * 導致 checkAllSectionsCovered 永遠判定 missing、passThreshold 卡死 false。
 */
const REQUIRED_STRUCTURE = `### 主檔章節結構（強制，順序與編號不可更動或自創）
主檔最上方（一、環境之前）必須依序有這四個區塊，缺一律視為未達標：
  IRR 模型與關鍵假設（情境分析表，台幣計價）
  結論總結（1–2 段）
  KEY QUESTION
  評分總表
接著才是四維框架：
一、環境
  1.1 產業起源與演進
  1.2 台灣市場定位與競爭格局
  1.3 兩岸地緣政治風險（必達）
  1.4 法規與政策環境
二、生意
  2.1 商業模式（≥25 則 CEO 直引言）
  2.2 財務分析（TIFRS 近 5–10 年）
  2.3 月營收趨勢（近 12 個月，必達）
  2.4 客戶集中度（前五大，必達）
  2.5 台幣 DCF 估值（必達）
三、組織
  3.1 廠區分布（竹科/中科/南科/海外，必達）
  3.2 研發能力與 ESG
  3.3 公司治理
四、人
  4.1 CEO 故事線（時間軸）
  4.2 管理團隊
建立骨架或新增章節時，標題必須是「## 1.1 產業起源與演進」這種格式（編號＋既定標題），不可自訂編號或跳過任何一節，且不可省略最上方四個區塊。`;

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
  inputTokens?: number;
  outputTokens?: number;
}

/** 取得主檔的最後修改時間（mtime），用於判斷本輪是否有寫入。 */
function getMainFileMtime(ticker: string): number {
  const p = path.join(PROJECT_ROOT, 'data', 'companies', ticker, `${ticker}_Initial_MAX.md`);
  try { return fs.statSync(p).mtimeMs; } catch { return 0; }
}

/** 讀取主檔全文（供附在 prompt 末尾供 Codex 對照）。 */
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

/** 組裝 gap-fill prompt。若主檔已含 PDF 連結，本機預先下載解析後一併附上。 */
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

  return `你是台股深度研究的投研編輯。你的任務是補強公司研究主檔的缺口。

## ${ticker} 研究缺口補充任務（第 ${round} 輪，${today}）${noWriteAlert}

**當前分數**：${gaps.score}/100（目標 ≥95/100）

### 優先缺口（依缺分高低排列）：
${topGaps}

### 工作目標：
主檔路徑：\`${mainFilePath}\`

### 任務指示：
1. 先讀取主檔，了解現有內容，避免重複。
2. 依優先缺口決定本輪補哪 1～2 個維度：
   - 缺財報數據 → 用 web_search 搜尋，或 curl 抓 MOPS 財報
   - 缺管理層原話 → web_search 搜尋 CEO 訪談
   - 缺產業 TAM → web_search 搜尋市場規模報告
3. web_search 最多 5 次，只用於真正需要補的缺口。
4. 取得資料後，**立即**將整理後的內容寫入主檔對應章節（保留既有內容，只補缺口章節，# 標題層級對齊主檔）。
   - 所有數據、引用必須附 https:// 來源連結
5. ⚠ **強制規定**：本輪必須至少寫入主檔一次，不得只研究不寫入。
6. 若下方已附「預先下載的 PDF 全文」，直接引用其內容，**不要**再自行嘗試抓取同一個 PDF 連結（該站台會擋掉非瀏覽器請求）。
7. ⚠ **禁止把過程紀錄寫進主檔正文**：不得出現「第 N 輪補強」「本輪新增」「更新後…覆蓋率由 X 提升至 Y」這類 changelog／meta 敘述。主檔只留**最終研究結論**（事實、數字、引言、來源連結）；你這輪做了什麼一律寫進最後那行 JSON 的 description，不要寫進正文。

### 完成後在最後輸出一行 JSON：
{"description": "補充了哪些內容（過程紀錄只寫這裡，不寫主檔正文）", "sections_written": ["1.1", "2.2"], "interviews_added": 數字}

${REQUIRED_STRUCTURE}
${mainFileText}${pdfAttachment}`;
}

/** 組裝 polish prompt。 */
function buildPolishPrompt(ticker: string, score: number): string {
  const today = new Date().toISOString().slice(0, 10);
  const mainFilePath = path.join(PROJECT_ROOT, 'data', 'companies', ticker, `${ticker}_Initial_MAX.md`).replace(/\\/g, '/');

  return `你是台股深度研究的投研編輯。本輪只做整理，不研究新內容。

## ${ticker} 研究主檔整理輪（${today}，分數 ${score}/100）

主檔路徑：\`${mainFilePath}\`

### 必做：
1. 讀取主檔全文
2. 刪除重複段落、重複表格、重複引言
3. 段落銜接順暢、標題層級一致、表格格式合法
4. 修正錯字與語病，保留所有數字、連結、出處
5. 寫回主檔（必須執行，不可只讀不寫）

### 完成後在最後輸出一行 JSON：
{"description": "polish 整理摘要", "sections_polished": ["1.1", "4.1"]}`;
}

/** 執行 `codex exec --json`，解析 JSONL 串流，回傳結果。 */
async function spawnCodex(prompt: string, timeoutMs = 900_000): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    // prompt 不走命令列（含換行/引號會被 shell 破壞），改由 stdin 傳入。
    // Windows 上 codex 是 .cmd 包裝，直接 spawn 會 EINVAL，必須經 shell。
    // 為避免「shell:true + args 陣列」的跳脫警告，這裡組成單一命令字串（無外部輸入，皆為常數），
    // 交給 spawn 的 shell:true 走 cmd.exe /c 執行；prompt 一律走 stdin，不進入這個字串。
    const isWin = process.platform === 'win32';
    const codexBin = isWin ? 'codex.cmd' : 'codex';
    const quotedRoot = isWin ? `"${PROJECT_ROOT}"` : PROJECT_ROOT;
    const command = [
      codexBin,
      'exec', '--json', '--skip-git-repo-check',
      '-C', quotedRoot,
      '-s', 'workspace-write',
      '-c', 'tools.web_search=true',
    ].join(' ');

    const proc = spawn(command, {
      cwd: PROJECT_ROOT,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: true,
      env: { ...process.env },
    });

    // prompt 透過 stdin 傳入後關閉
    proc.stdin.write(prompt);
    proc.stdin.end();

    let stdout = '';
    let stderr = '';
    let lastAgentMessage = '';
    let errorMessage: string | null = null;
    let usage: { input_tokens?: number; output_tokens?: number } = {};
    let buffer = '';

    proc.stdout.on('data', (d: Buffer) => {
      stdout += d.toString();
      buffer += d.toString();
      // 逐行解析 JSONL：agent_message 取 text，turn.completed 取 usage，
      // error/turn.failed 取真正的失敗原因（例如額度用完），不然 close 時只能
      // fallback 到 stdout 開頭的「Reading prompt from stdin...」這種無意義文字。
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const t = line.trim();
        if (!t) continue;
        try {
          const ev = JSON.parse(t);
          if (ev.type === 'item.completed' && ev.item?.type === 'agent_message') {
            lastAgentMessage = ev.item.text ?? lastAgentMessage;
          } else if (ev.type === 'turn.completed' && ev.usage) {
            usage = ev.usage;
          } else if (ev.type === 'turn.failed' || ev.type === 'error') {
            errorMessage = ev.error?.message ?? ev.message ?? errorMessage;
          }
        } catch { /* 非 JSON 行忽略 */ }
      }
    });
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error(`codex CLI timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0 && !lastAgentMessage) {
        reject(new Error(`codex CLI exited ${code}: ${errorMessage ?? (stderr.slice(0, 200) || stdout.slice(0, 200))}`));
        return;
      }
      resolve({
        response: lastAgentMessage || '(no agent message)',
        inputTokens: usage.input_tokens,
        outputTokens: usage.output_tokens,
      });
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`Failed to spawn codex: ${err.message}`));
    });
  });
}

/**
 * 以 Codex CLI 執行一輪 gap-fill 研究。
 * 介面與 runGapFillAgent() / runClaudeCliAgent() 相容。
 */
export async function runCodexCliAgent(
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

  const result = await spawnCodex(prompt);

  const mtimeAfter = getMainFileMtime(ticker);
  const wroteToMainFile = mtimeAfter > mtimeBefore;

  if (result.inputTokens !== undefined) {
    console.log(`  [codex-cli] tokens in=${result.inputTokens} out=${result.outputTokens ?? 0}`);
  }

  return { response: result.response, wroteToMainFile };
}
