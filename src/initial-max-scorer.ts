/**
 * Initial MAX Scorer
 *
 * 使用 google/gemini-3.1-pro-preview 對公司研究報告打分（張磊四維框架，100分）。
 * 提供 LLM 打分 + heuristic fallback。
 *
 * Usage (standalone):
 *   npx tsx src/initial-max-scorer.ts --ticker FUTU
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { chat, geminiGenerateContent } from './llm.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

/**
 * 評分固定模型。用 gemini-2.5-flash 而非 Pro，原因是評分穩定性靠兩個機制：
 *   1. temperature:0 → 確定性（這才是「同份報告震盪 40 分」的真因）
 *   2. thinkingBudget:0 → 關閉思考模式，避免思考 token 形成早期偏見（曾導致 組織=0）
 * gemini-3.1-pro-preview 是「強制思考」模型，不接受 thinkingBudget:0（HTTP 400），
 * 無法套用機制 2，反而把偏差帶回來，又更貴。故評分用 flash 才正確。
 * 與「研究/補缺口」共用同一模型沒問題——關鍵是評分端鎖定 temp:0 + 關思考。
 */
export const SCORER_MODEL = 'google/gemini-2.5-flash';

const PASS_TOTAL = 95;
const MIN_環境 = 16;
const MIN_生意 = 30;
const MIN_組織 = 16;
const MIN_人 = 20;

/**
 * 市值分級 → 只決定「整體達標門檻」（institutional 期待），
 * **不影響任何單一維度如何給分**（尤其「人」維度已改為涵蓋率×深度，與市值脫鉤）。
 * 大型股資料豐沛、要求嚴；中小型放寬。數字可依需要調整。
 */
export type CapTier = 'large' | 'mid' | 'small' | 'unknown';
interface TierThreshold { total: number; 環境: number; 生意: number; 組織: number; 人: number; }
const TIER_THRESHOLDS: Record<CapTier, TierThreshold> = {
  large:   { total: 95, 環境: 16, 生意: 30, 組織: 16, 人: 20 }, // ≥500 億
  mid:     { total: 75, 環境: 14, 生意: 25, 組織: 13, 人: 14 }, // 30–500 億
  small:   { total: 60, 環境: 12, 生意: 22, 組織: 10, 人: 12 }, // <30 億
  unknown: { total: 75, 環境: 14, 生意: 25, 組織: 13, 人: 14 }, // 抓不到市值→比照中型（保守）
};

/** 從報告擷取市值（億元）。容錯「約」「NT$」「逗號」等格式。 */
function detectMarketCapB(report: string): number | null {
  const m = report.match(/市值[：:]?\s*(?:約\s*)?(?:NT\$?\s*)?([\d,]+(?:\.\d+)?)\s*億/);
  return m ? parseFloat(m[1].replace(/,/g, '')) : null;
}

function capTier(mktCapB: number | null): CapTier {
  if (mktCapB === null) return 'unknown';
  if (mktCapB >= 500) return 'large';
  if (mktCapB >= 30)  return 'mid';
  return 'small';
}

/** 主檔必備子節（1.1～4.2），每節皆須有實質內容才達標 */
const REQUIRED_SECTIONS = ['1.1', '1.2', '1.3', '1.4', '2.1', '2.2', '2.3', '2.4', '2.5', '3.1', '3.2', '3.3', '4.1', '4.2'];
const MIN_SECTION_CHARS = 80;

export interface DimensionScore {
  score: number;
  max: number;
  criteria?: Record<string, number>;
  gaps: string[];
}

export interface InitialMaxScore {
  環境: DimensionScore;
  生意: DimensionScore;
  組織: DimensionScore;
  人: DimensionScore;
  total: number;
  passThreshold: boolean;
  round: number;
}

interface GapItem {
  dimension: string;
  item: string;
  current: number | string;
  target: string;
  shortfall: number;
  priority: number;
}

export interface InitialMaxGaps {
  round: number;
  score: number;
  gaps: GapItem[];
}

// ── File reading helpers ──

function getCompanyDir(ticker: string): string {
  return path.join(PROJECT_ROOT, 'data', 'companies', ticker);
}

function readResearchFiles(ticker: string): string {
  const dir = getCompanyDir(ticker);
  if (!fs.existsSync(dir)) return '';

  const targetFiles = [
    `${ticker}_Initial_MAX.md`,
    `${ticker}_Super_Initial_*.md`,
    `${ticker}_Initial_*.md`,
    'initial_financial.md',
    'initial_business_model.md',
    'initial_market_size.md',
    'initial_management.md',
    'initial_products_services.md',
    'initial_competition.md',
    'super_initial_section_*.md',
    'super_initial_five_forces_*.md',
    `dcf_valuation_*.md`,
  ];

  const collected: string[] = [];
  const allFiles = fs.readdirSync(dir);

  for (const pattern of targetFiles) {
    const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
    for (const f of allFiles) {
      if (regex.test(f)) {
        const fullPath = path.join(dir, f);
        try {
          const content = fs.readFileSync(fullPath, 'utf-8');
          collected.push(`\n\n=== ${f} ===\n${content.slice(0, 15000)}`);
        } catch {}
      }
    }
  }

  // Also check transcripts directory for interview count
  const transcriptsDir = path.join(dir, 'transcripts');
  if (fs.existsSync(transcriptsDir)) {
    const transcriptFiles = fs.readdirSync(transcriptsDir).filter(f => f.endsWith('.md') || f.endsWith('.txt'));
    collected.push(`\n\n=== TRANSCRIPTS INDEX (${transcriptFiles.length} files downloaded) ===\n${transcriptFiles.join('\n')}`);
  }

  return collected.join('');
}

/** 檢查主檔是否每個必備子節（1.1～4.2）皆有實質內容；缺節或僅「待補充」視為未覆蓋。 */
function checkAllSectionsCovered(mainContent: string): { allCovered: boolean; missing: string[] } {
  const missing: string[] = [];
  const lines = mainContent.split('\n');
  for (const id of REQUIRED_SECTIONS) {
    // Find any heading line (##, ###, ####) that starts with the section number id (e.g. "1.1", "4.2")
    const headingLineIdx = lines.findIndex(line => {
      if (!line.startsWith('#')) return false;
      const stripped = line.replace(/^#+\s*/, '');
      return stripped.startsWith(id + ' ') || stripped.startsWith(id + '\t') || stripped === id;
    });
    if (headingLineIdx === -1) {
      missing.push(id);
      continue;
    }
    // Gather body lines until next heading of same or higher level
    const headingLevel = (lines[headingLineIdx].match(/^#+/) ?? [''])[0].length;
    let body = '';
    for (let i = headingLineIdx + 1; i < lines.length; i++) {
      const m = lines[i].match(/^(#+)/);
      if (m && m[1].length <= headingLevel) break;
      body += lines[i] + '\n';
    }
    body = body.replace(/\s+/g, ' ').trim();
    if (body.length < MIN_SECTION_CHARS || /^待補充\s*$/.test(body)) missing.push(id);
  }
  return { allCovered: missing.length === 0, missing };
}

// ── Heuristic fallback scorer ──

/** 從單一主檔 {TICKER}_Initial_MAX.md 內文評分。 */
function scoreFromMainFile(content: string): { 環境: number; 生意: number; 組織: number; 人: number } {
  let 環境 = 0;
  if (/\d+[BMT]|\d+億|TAM|addressable market/i.test(content)) 環境 += 5;
  if (/市占|market share|concentration|consolidat|競爭|competition/i.test(content)) 環境 += 5;
  if (/regulat|監管|法規|policy|政策/i.test(content)) 環境 += 5;
  if (/trend|趨勢|adoption|AI|cloud|技術/i.test(content)) 環境 += 3;

  let 生意 = 0;
  const yearMatches = content.match(/20\d\d/g) ?? [];
  生意 += Math.min(new Set(yearMatches).size, 10);
  const quotes = (content.match(/"|「|『/g) ?? []).length;
  生意 += Math.min(Math.floor(quotes / 4), 10);
  if (/五力|Five Forces|5a|5b|5c|5d|5e|護城河|moat/i.test(content)) 生意 += 10;
  if (/DCF|IRR|dcf_config|情境.*估值/i.test(content)) 生意 += 5;
  生意 = Math.min(生意, 35);

  let 組織 = 0;
  if (/來源|source|10-K|20-F|法說|earnings call/i.test(content)) 組織 += 4;
  if (/\|.*\|.*\|/.test(content) && /region|地區|市場|segment|部門|營收/i.test(content)) 組織 += 4;
  if (/penetrat|滲透率|market share|市占/i.test(content)) 組織 += 2;
  if (/ROIC|return on invested|operating leverage|費用率/i.test(content)) 組織 += 6;
  if (/culture|文化|incentive|激勵|talent|人才/i.test(content)) 組織 += 4;
  組織 = Math.min(組織, 20);

  let 人 = 0;
  const urlCount = (content.match(/https?:\/\//g) ?? []).length;
  人 += Math.min(Math.floor((urlCount / 25) * 15), 15);
  if (/philosophy|哲學|第一性原理|first principle|vision|格局|故事線/i.test(content)) 人 += 5;
  if (/integrity|誠信|value|創造價值|moral|責任/i.test(content)) 人 += 3;
  人 = Math.min(人, 25);
  return { 環境, 生意, 組織, 人 };
}

function heuristicScore(ticker: string, threshold: TierThreshold = TIER_THRESHOLDS.large): InitialMaxScore {
  const dir = getCompanyDir(ticker);
  const allFiles = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  const mainFile = path.join(dir, `${ticker}_Initial_MAX.md`);

  let 環境Score = 0;
  let 生意Score = 0;
  let 組織Score = 0;
  let 人Score = 0;

  if (fs.existsSync(mainFile)) {
    const mainContent = fs.readFileSync(mainFile, 'utf-8');
    const fromMain = scoreFromMainFile(mainContent);
    環境Score = fromMain.環境;
    生意Score = fromMain.生意;
    組織Score = fromMain.組織;
    人Score = fromMain.人;
  }

  const transcriptsDir = path.join(dir, 'transcripts');
  if (fs.existsSync(transcriptsDir)) {
    const count = fs.readdirSync(transcriptsDir).length;
    人Score = Math.min(25, 人Score + Math.min(Math.floor((count / 25) * 10), 10));
  }

  if (!fs.existsSync(mainFile)) {
    const marketFile = path.join(dir, 'initial_market_size.md');
    const finFile = path.join(dir, 'initial_financial.md');
    const bizFile = path.join(dir, 'initial_business_model.md');
    const mgmtFile = path.join(dir, 'initial_management.md');
    let 組織ScoreScattered = 0;
    let 人ScoreScattered = 0;
    if (fs.existsSync(marketFile)) {
      const c = fs.readFileSync(marketFile, 'utf-8');
      if (/\d+[BMT]|\d+億/.test(c)) 環境Score += 5;
      if (/市占|market share|concentration|consolidat/i.test(c)) 環境Score += 5;
      if (/regulat|監管|法規|policy|政策/i.test(c)) 環境Score += 5;
      if (/trend|趨勢|adoption|AI|cloud/i.test(c)) 環境Score += 3;
    }
    if (fs.existsSync(finFile)) {
      const c = fs.readFileSync(finFile, 'utf-8');
      生意Score += Math.min((c.match(/20\d\d/g) ?? []).length, 10);
    }
    if (fs.existsSync(bizFile)) {
      const c = fs.readFileSync(bizFile, 'utf-8');
      生意Score += Math.min(Math.floor(((c.match(/"|「|『/g) ?? []).length) / 4), 10);
    }
    生意Score += Math.min(allFiles.filter(f => /five_forces|5[a-e]_/i.test(f)).length * 2, 10);
    if (allFiles.some(f => f.startsWith('dcf_valuation') || f === 'dcf_config.json')) 生意Score += 5;
    生意Score = Math.min(生意Score, 35);
    if (fs.existsSync(marketFile)) {
      const c = fs.readFileSync(marketFile, 'utf-8');
      if (/來源|source|10-K|20-F|法說/i.test(c)) 組織ScoreScattered += 4;
      if (/\|.*\|.*\|/.test(c) && /region|地區|市場/i.test(c)) 組織ScoreScattered += 4;
      if (/penetrat|滲透率|市占/i.test(c)) 組織ScoreScattered += 2;
    }
    if (fs.existsSync(mgmtFile)) {
      const c = fs.readFileSync(mgmtFile, 'utf-8');
      if (/ROIC|operating leverage|費用率/i.test(c)) 組織ScoreScattered += 6;
      if (/culture|文化|incentive|激勵|talent|人才/i.test(c)) 組織ScoreScattered += 4;
      const urlCount = (c.match(/https?:\/\//g) ?? []).length;
      人ScoreScattered += Math.min(Math.floor((urlCount / 25) * 15), 15);
      if (/philosophy|哲學|第一性原理|vision|格局/i.test(c)) 人ScoreScattered += 5;
      if (/integrity|誠信|value|創造價值|moral|責任/i.test(c)) 人ScoreScattered += 3;
    }
    if (fs.existsSync(transcriptsDir)) {
      人ScoreScattered += Math.min(Math.floor((fs.readdirSync(transcriptsDir).length / 25) * 10), 10);
    }
    組織Score = Math.min(組織ScoreScattered, 20);
    人Score = Math.min(人ScoreScattered, 25);
  }

  const total = Math.min(環境Score + 生意Score + 組織Score + 人Score, 100);

  let hasDCF = false;
  if (fs.existsSync(mainFile)) {
    const mainContent = fs.readFileSync(mainFile, 'utf-8');
    hasDCF = /2\.5|DCF|情境.*估值|dcf_config|IRR.*拆分|三情境|樂觀.*保守/i.test(mainContent);
  } else {
    hasDCF = allFiles.some(f => f.startsWith('dcf_valuation') || f === 'dcf_config.json');
  }

  let sectionCoverage = { allCovered: true as boolean, missing: [] as string[] };
  if (fs.existsSync(mainFile)) {
    const mainContent = fs.readFileSync(mainFile, 'utf-8');
    sectionCoverage = checkAllSectionsCovered(mainContent);
  }

  const passThreshold =
    total >= threshold.total &&
    環境Score >= threshold.環境 &&
    生意Score >= threshold.生意 &&
    組織Score >= threshold.組織 &&
    人Score >= threshold.人 &&
    hasDCF &&
    sectionCoverage.allCovered;

  const sectionGap = sectionCoverage.missing.length ? [`子節未全覆蓋：${sectionCoverage.missing.join('、')} 須有實質內容`] : [];

  return {
    環境: { score: 環境Score, max: 20, gaps: [...(環境Score < MIN_環境 ? ['需補充市場結構/監管資料'] : []), ...sectionGap] },
    生意: { score: 生意Score, max: 35, gaps: 生意Score < MIN_生意 || !hasDCF ? ['需補充財務歷史/≥25 CEO引言/五力/2.5 DCF估值(必達)'] : [] },
    組織: { score: 組織Score, max: 20, gaps: 組織Score < MIN_組織 ? ['需補充地理分部(含出處)/ROIC分析'] : [] },
    人: { score: 人Score, max: 25, gaps: 人Score < MIN_人 ? ['需補充訪談≥25篇並下載逐字稿'] : [] },
    total,
    passThreshold,
    round: 0,
  };
}

// ── LLM scorer ──

const SCORER_SYSTEM_PROMPT = `你是一位專業的投資研究品質評審。請根據張磊（高瓴資本）「環境→生意→組織→人」投資研究框架，對以下公司研究報告進行**嚴格**評分。

**達標條件（須全部滿足）**：總分 ≥ **95 分**，且各維度達最低分：環境≥16、生意≥30、組織≥16、人≥20；**缺「2.5 DCF 估值」小節（情境表/三表/IRR 或 dcf_config）則生意維度不得達標**（DCF 為必達項）。**每個子節（1.1～4.2）皆須有實質內容**，缺一則不達標。
**內容深度**：**環境**須從**該產業的起源或現代形態起點**論述（例如廣告業從現代廣告誕生開始）；**4.1 CEO/創業家**須從**學經歷**開始，含**重要拐點、重要成就、每個時期的訪談**、**成功與失敗的檢討與反思**；不足者扣分。

## 評分框架（100分）

### 一、環境 (20分，最低 16 才達標)
- TAM & 產業成長趨勢（有數字+出處）：0-5分
- 市場結構（集中化/碎片化分析）：0-5分
- 監管/政策環境（主要法規風險+機會）：0-5分
- 技術與需求趨勢（採用曲線/需求轉變論述）：0-5分

### 二、生意 (35分，最低 30 才達標；**2.5 DCF 為必達**)
- 財務歷史完整度（≥10年表格，含毛利/營業利益/EPS，轉折點說明）：0-10分
- 商業模式深度（收入拆分+unit economics+**≥25個CEO直引言**，每則須引號+出處+日期）：0-10分
- 競爭護城河（Five Forces 5a-5e 全齊+技術差異段落+CEO護城河引言）：0-10分
- **DCF/投資論文（2.5 小節必達）**：dcf_config 或主檔內三情境+IRR拆分，缺則生意不得達標：0-5分

### 三、組織 (20分，最低 16 才達標)
- 地理/業務分部收入（來自年報/法說逐字稿，**含明確出處頁碼/日期**，無出處不計分）：0-8分
- 組織文化與激勵機制（人才策略+股權激勵+逆勢擴張案例）：0-6分
- 運營效率（ROIC趨勢計算/Operating Leverage分析）：0-6分

### 四、人 (25分)
> ⚠️ **本維度計分與公司市值/規模完全無關**。市值只決定整體達標門檻，不影響「人」如何給分。
- CEO格局觀與商業哲學（多年敘事，第一性原理決策邏輯）：0-5分
- 道德操守與價值創造驅動力（具體案例佐證，非泛泛描述）：0-5分
- **CEO 訪談材料運用（涵蓋率 × 分析深度）：0-15分**
  - **評的是「研究者有沒有把『實際存在』的 CEO 公開材料抓全、用好」，不是絕對篇數。**
  - **嚴禁用固定篇數門檻（如 25 篇、5 篇）扣分。** 低調 CEO 公開受訪本就稀少；若報告已捕捉所有可得的訪談/逐字稿（有 URL），並從中萃取關鍵原話、串成跨年代敘事、做出有洞見的分析，**本項可給滿分 15**。
  - 給分依據：①涵蓋率——是否把現存可得的 CEO 訪談都找到並引用（見下方【證據普查】提示，若有）；②深度——是否不只堆引言，而是分析其決策邏輯、轉折、反思。
  - 僅有 1–2 則淺層引用、無分析 → 低分（3–6）；涵蓋齊全且分析透徹 → 高分（12–15）。

## 嚴格扣分規則（必遵）
- **無出處的數字一律不計分**：TAM、市占、營收、地理分部等未標年報/法說出處則該項扣分。
- **出處應可驗證**：在通常可取得公開連結的情境下（年報、法說、新聞、訪談），若僅寫來源名稱或檔名而**無 \`http(s)\` 連結**，該條出處從嚴扣分；已附可點擊連結者從寬。
- **每個子點（1.1～4.1）須至少 5 則管理層直接引述**（引號「…」或 "…" + 出處+日期）；不足 5 則或為間接描述者，扣該維度分。
- **CEO 引言**：僅計**直接引述**（有引號包住）；間接描述、轉述、無出處者不計入。
- **訪談**：只計有實際 URL 的條目。**「人」維度的訪談項按涵蓋率×深度給分（見上），不設絕對篇數門檻。**
- 從嚴給分：可給可不給時給較低分；缺關鍵元素明顯扣分。**唯「人」維度訪談項例外——不得因「篇數少」扣分，只看是否抓全現存材料並深入分析。**

## 輸出格式

請輸出純 JSON（不加 code fence，不加其他文字）：
{
  "環境": {
    "score": 數字,
    "max": 20,
    "criteria": {"TAM趨勢": 數字, "市場結構": 數字, "監管政策": 數字, "技術趨勢": 數字},
    "gaps": ["具體缺口描述1", "具體缺口描述2"]
  },
  "生意": {
    "score": 數字,
    "max": 35,
    "criteria": {"財務歷史": 數字, "商業模式": 數字, "五力分析": 數字, "DCF投資論文": 數字},
    "gaps": ["具體缺口描述"]
  },
  "組織": {
    "score": 數字,
    "max": 20,
    "criteria": {"地理分部": 數字, "組織文化": 數字, "運營效率": 數字},
    "gaps": ["具體缺口描述"]
  },
  "人": {
    "score": 數字,
    "max": 25,
    "criteria": {"格局觀哲學": 數字, "道德操守": 數字, "訪談逐字稿": 數字},
    "gaps": ["具體缺口描述"]
  },
  "total": 數字
}`;

/** 從報告擷取 CEO 姓名（4.1 標題括號內，或常見職稱行）。 */
function extractCeoName(report: string): string | null {
  const h = report.match(/4\.1[^\n（(]*[（(]([一-龥]{2,4})[）)]/);
  if (h) return h[1].trim();
  // 職稱後緊接姓名；姓名限 2–3 字並排除常見接續字（從/在/於/曾/自/暨）避免多抓
  const r = report.match(/(?:董事長|總經理|執行長|創辦人)[暨兼，、\s]{0,4}([一-龥]{2,3})(?![一-龥])/);
  return r ? r[1].replace(/[從在於曾自暨]$/, '') : null;
}

/**
 * 證據普查（A，輔助）：用 Brave 估「該 CEO 網路上實際存在幾個合格訪談來源」，
 * 當作「人」維度涵蓋率的分母提示。無 Brave key 或失敗 → 回 null，評分照常（純輔助）。
 */
async function evidenceCensus(ceoName: string): Promise<number | null> {
  const key = process.env.BRAVE_SEARCH_API_KEY ?? '';
  if (!key || key === 'REPLACE_ME') return null;
  const domainHints = /(youtube|youtu\.be|ctee|chinatimes|udn|cnyes|gbimonthly|geneonline|bnext|cw\.com|businessweekly|businesstoday|moneydj|ntdtv|wealth|gvm|anue)/i;
  const seen = new Set<string>();
  try {
    for (const q of [`${ceoName} 專訪 OR 訪談`, `${ceoName} 法說 OR 演講`]) {
      const url = new URL('https://api.search.brave.com/res/v1/web/search');
      url.searchParams.set('q', q);
      url.searchParams.set('count', '15');
      const r = await fetch(url, { headers: { Accept: 'application/json', 'X-Subscription-Token': key }, signal: AbortSignal.timeout(15000) });
      if (!r.ok) continue;
      const d = await r.json() as any;
      for (const item of (d.web?.results ?? [])) {
        const u: string = item.url ?? '';
        const title: string = item.title ?? '';
        if (domainHints.test(u) && (title.includes(ceoName) || /專訪|訪談|法說|演講|對談/.test(title))) {
          seen.add(u.split('?')[0]);
        }
      }
    }
  } catch { return null; }
  return seen.size || null;
}

/** 依市值分級與證據普查，動態組附加條款（脫鉤市值與「人」維度計分）。 */
function buildSupplement(tier: CapTier, census: number | null): string {
  const parts: string[] = [];
  if (census !== null) {
    parts.push(`【證據普查】引擎實搜該 CEO，網路上約可找到 **${census}** 個合格的公開訪談/法說來源。\n評「CEO 訪談材料運用」時，以此為**涵蓋率分母參考**：報告已捕捉其中大部分並深入分析即應給高分；**絕不可因「篇數少」本身扣分**（這位 CEO 公開受訪本就只有這麼多）。`);
  }
  if (tier !== 'large') {
    parts.push(`【揭露有限之公平評分】本標的非大型股，部分公開資訊先天較少：\n- 每子點引言門檻從 ≥5 則降為 ≥2 則（有 URL 出處即計分）。\n- 若某維度受限於「公司/CEO 公開揭露本就稀少」（非研究不力），給該維度滿分的 70% 作為基準分，而非 0 分。\n- 法說/新聞替代訪談視同有效出處。不得因「曝光少」大量扣分；重點是研究者是否抓全所有可得資料。`);
  }
  if (!parts.length) return '';
  return `\n\n---\n## ⚠️ 本次評分附加條款\n\n` + parts.join('\n\n');
}

async function llmScore(
  ticker: string,
  reportContent: string,
  model = SCORER_MODEL,
  supplement = '',
  threshold: TierThreshold = TIER_THRESHOLDS.large,
): Promise<InitialMaxScore | null> {
  const systemPrompt = SCORER_SYSTEM_PROMPT + supplement;

  const userMessage = `請評分以下 ${ticker} 的研究報告：

${reportContent.slice(0, 80000)}`;

  try {
    let rawText: string | null;
    const isGoogle = model.startsWith('google/') || model.startsWith('gemini-');

    if (isGoogle) {
      // Use native Gemini generateContent with thinkingBudget=0.
      // The OpenAI-compat endpoint does NOT support thinking_config → 400 error.
      // Native endpoint supports thinkingConfig and filters out thought parts automatically.
      // 思考強制型模型（如 gemini-3.1-pro-preview）拒絕 thinkingBudget:0（HTTP 400），
      // 須讓它思考並放大 token 上限容納思考；其餘模型（flash）關閉思考避免思考偏見。
      const thinkingMandatory = /pro-preview|3\.1-pro|2\.5-pro/.test(model);
      rawText = await geminiGenerateContent(model, systemPrompt, userMessage, {
        maxTokens: thinkingMandatory ? 16000 : 8000,
        temperature: 0, // 評分必須確定性：缺此參數時 Gemini 預設 temp≈1.0，同份報告分數震盪達 40 分
        ...(thinkingMandatory ? {} : { thinkingBudget: 0 }),
      });
    } else {
      const response = await chat(
        [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage },
        ],
        { model, maxTokens: 8000, noFreeTier: true, temperature: 0 },
      );
      rawText = response.content;
    }

    if (!rawText) {
      console.warn('[scorer] LLM returned null/empty content');
      return null;
    }

    function extractOutermostJson(text: string): string | null {
      // 1. code fence
      const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
      if (fenceMatch) return fenceMatch[1].trim();
      // 2. 從尾找最後一個完整 {} 含評分 key
      let depth = 0;
      for (let i = text.length - 1; i >= 0; i--) {
        if (text[i] === '}') depth++;
        else if (text[i] === '{') {
          depth--;
          if (depth === 0) {
            const candidate = text.slice(i);
            if (/環境|生意|組織|人/.test(candidate)) return candidate;
            depth = 0; // 不符合，繼續往前找
          }
        }
      }
      // 3. 最後備用：首個 {
      const s = text.indexOf('{');
      return s !== -1 ? text.slice(s) : null;
    }

    const extracted = extractOutermostJson(rawText.trim());
    if (!extracted) {
      console.warn(`[scorer] No JSON found in response (first 200 chars): ${rawText.slice(0, 200)}`);
      return null;
    }

    // Find outermost { } bounds within the extracted string
    let depth2 = 0;
    let end = -1;
    for (let i = 0; i < extracted.length; i++) {
      if (extracted[i] === '{') depth2++;
      else if (extracted[i] === '}') { depth2--; if (depth2 === 0) { end = i; break; } }
    }
    if (end === -1) return null;

    const parsed = JSON.parse(extracted.slice(0, end + 1));
    const total = parsed.total ?? (
      (parsed['環境']?.score ?? 0) +
      (parsed['生意']?.score ?? 0) +
      (parsed['組織']?.score ?? 0) +
      (parsed['人']?.score ?? 0)
    );

    const 環境 = parsed['環境']?.score ?? 0;
    const 生意 = parsed['生意']?.score ?? 0;
    const 組織 = parsed['組織']?.score ?? 0;
    const 人 = parsed['人']?.score ?? 0;
    const passThreshold =
      total >= threshold.total &&
      環境 >= threshold.環境 &&
      生意 >= threshold.生意 &&
      組織 >= threshold.組織 &&
      人 >= threshold.人;

    return {
      環境: { score: 環境, max: 20, criteria: parsed['環境']?.criteria, gaps: parsed['環境']?.gaps ?? [] },
      生意: { score: 生意, max: 35, criteria: parsed['生意']?.criteria, gaps: parsed['生意']?.gaps ?? [] },
      組織: { score: 組織, max: 20, criteria: parsed['組織']?.criteria, gaps: parsed['組織']?.gaps ?? [] },
      人: { score: 人, max: 25, criteria: parsed['人']?.criteria, gaps: parsed['人']?.gaps ?? [] },
      total,
      passThreshold,
      round: 0,
    };
  } catch (err: any) {
    console.error('LLM scorer error:', err.message);
    return null;
  }
}

// ── Gap builder ──

function buildGapsJson(score: InitialMaxScore, round: number): InitialMaxGaps {
  const gaps: GapItem[] = [];
  let priority = 1;

  // 人維度 (25pts) — 高回報缺口
  const 人訪談Score = score.人.criteria?.['訪談逐字稿'] ?? Math.floor(score.人.score * 0.6);
  if (人訪談Score < 15) {
    const currentInterviews = Math.floor((人訪談Score / 15) * 25);
    gaps.push({
      dimension: '人', item: '訪談篇數+逐字稿',
      current: currentInterviews, target: '≥25篇並下載逐字稿',
      shortfall: Math.max(0, 25 - currentInterviews), priority: priority++,
    });
  }
  if ((score.人.criteria?.['格局觀哲學'] ?? 0) < 4) {
    gaps.push({ dimension: '人', item: 'CEO格局觀與商業哲學', current: score.人.criteria?.['格局觀哲學'] ?? 0, target: '5分', shortfall: 5 - (score.人.criteria?.['格局觀哲學'] ?? 0), priority: priority++ });
  }

  // 生意維度 (35pts)
  if ((score.生意.criteria?.['財務歷史'] ?? 0) < 8) {
    gaps.push({ dimension: '生意', item: '財務歷史完整度', current: score.生意.criteria?.['財務歷史'] ?? 0, target: '10分（≥10年表格）', shortfall: 10 - (score.生意.criteria?.['財務歷史'] ?? 0), priority: priority++ });
  }
  if ((score.生意.criteria?.['商業模式'] ?? 0) < 8) {
    gaps.push({ dimension: '生意', item: '商業模式深度(≥25個CEO直引言)', current: score.生意.criteria?.['商業模式'] ?? 0, target: '10分', shortfall: 10 - (score.生意.criteria?.['商業模式'] ?? 0), priority: priority++ });
  }
  if ((score.生意.criteria?.['五力分析'] ?? 0) < 8) {
    gaps.push({ dimension: '生意', item: '五力分析完整度', current: score.生意.criteria?.['五力分析'] ?? 0, target: '10分', shortfall: 10 - (score.生意.criteria?.['五力分析'] ?? 0), priority: priority++ });
  }
  if ((score.生意.criteria?.['DCF投資論文'] ?? 0) < 4) {
    gaps.push({ dimension: '生意', item: 'DCF模型+三情境+IRR拆分', current: score.生意.criteria?.['DCF投資論文'] ?? 0, target: '5分', shortfall: 5 - (score.生意.criteria?.['DCF投資論文'] ?? 0), priority: priority++ });
  }

  // 組織維度 (20pts)
  if ((score.組織.criteria?.['地理分部'] ?? 0) < 6) {
    gaps.push({ dimension: '組織', item: '地理/業務分部收入(年報出處)', current: score.組織.criteria?.['地理分部'] ?? 0, target: '8分', shortfall: 8 - (score.組織.criteria?.['地理分部'] ?? 0), priority: priority++ });
  }
  if ((score.組織.criteria?.['運營效率'] ?? 0) < 4) {
    gaps.push({ dimension: '組織', item: 'ROIC趨勢/Operating Leverage', current: score.組織.criteria?.['運營效率'] ?? 0, target: '6分', shortfall: 6 - (score.組織.criteria?.['運營效率'] ?? 0), priority: priority++ });
  }

  // 環境維度 (20pts)
  if (score.環境.score < 16) {
    for (const gap of score.環境.gaps) {
      gaps.push({ dimension: '環境', item: gap, current: 0, target: '完整', shortfall: 20 - score.環境.score, priority: priority++ });
    }
  }

  // Sort by shortfall descending
  gaps.sort((a, b) => b.shortfall - a.shortfall);
  gaps.forEach((g, i) => { g.priority = i + 1; });

  return { round, score: score.total, gaps };
}

// ── Main exported function ──

export async function scoreCompanyResearch(
  ticker: string,
  round = 0,
  model = SCORER_MODEL,
  market = 'US',
): Promise<{ score: InitialMaxScore; gaps: InitialMaxGaps }> {
  const reportContent = readResearchFiles(ticker);
  const dir = getCompanyDir(ticker);
  // 市值只決定「整體達標門檻」（large/mid/small），不影響任何維度如何給分。
  // market 旗標只代表交易所，不等於規模——一律以報告中的市值數字分級。
  const mktCapB = detectMarketCapB(reportContent);
  const tier = capTier(mktCapB);
  const threshold = TIER_THRESHOLDS[tier];

  let score: InitialMaxScore;

  if (reportContent.trim().length < 100) {
    console.log(`[scorer] No research files found for ${ticker}, using zero score`);
    score = {
      環境: { score: 0, max: 20, gaps: ['無研究資料'] },
      生意: { score: 0, max: 35, gaps: ['無研究資料'] },
      組織: { score: 0, max: 20, gaps: ['無研究資料'] },
      人: { score: 0, max: 25, gaps: ['無研究資料'] },
      total: 0,
      passThreshold: false,
      round,
    };
  } else {
    // 證據普查（A，輔助）：估該 CEO 實際可得訪談數，當「人」維度涵蓋率分母提示。
    const ceoName = extractCeoName(reportContent);
    const census = ceoName ? await evidenceCensus(ceoName) : null;
    const supplement = buildSupplement(tier, census);
    console.log(`[scorer] tier=${tier}${mktCapB !== null ? `(${mktCapB}億)` : '(市值未知)'} 門檻=${threshold.total}` +
      (census !== null ? ` 證據普查:${ceoName}≈${census}篇` : ''));

    // Try LLM scorer
    console.log(`[scorer] Running LLM scorer (${model}) for ${ticker}...`);
    const llmResult = await llmScore(ticker, reportContent, model, supplement, threshold);

    if (llmResult) {
      score = { ...llmResult, round };
      const mainFile = path.join(dir, `${ticker}_Initial_MAX.md`);
      if (fs.existsSync(mainFile)) {
        const sectionCoverage = checkAllSectionsCovered(fs.readFileSync(mainFile, 'utf-8'));
        if (!sectionCoverage.allCovered) {
          score.passThreshold = false;
          score.環境.gaps = [...score.環境.gaps, `子節未全覆蓋：${sectionCoverage.missing.join('、')} 須有實質內容`];
        }
      }
      console.log(`[scorer] LLM score: ${score.total}/100 (環境:${score.環境.score} 生意:${score.生意.score} 組織:${score.組織.score} 人:${score.人.score})`);
    } else {
      // Heuristic fallback
      console.log('[scorer] LLM failed, using heuristic fallback');
      score = { ...heuristicScore(ticker, threshold), round };
      console.log(`[scorer] Heuristic score: ${score.total}/100`);
    }
  }

  const gaps = buildGapsJson(score, round);

  // Write score and gaps files
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `initial_max_score_${round}.json`),
    JSON.stringify(score, null, 2),
  );
  fs.writeFileSync(
    path.join(dir, `initial_max_gaps_${round}.json`),
    JSON.stringify(gaps, null, 2),
  );

  return { score, gaps };
}

// ── CLI entry point ──

async function main() {
  const args: Record<string, string> = {};
  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const val = process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[++i] : 'true';
      args[key] = val;
    }
  }

  const ticker = args.ticker ?? args.t;
  if (!ticker) {
    console.error('Usage: npx tsx src/initial-max-scorer.ts --ticker FUTU');
    process.exit(1);
  }

  const model = args.model ?? SCORER_MODEL;
  const round = parseInt(args.round ?? '0', 10);
  const market = args.market ?? 'US';

  const { score } = await scoreCompanyResearch(ticker.toUpperCase(), round, model, market);

  // 門檻依市值分級（large≥95 / mid≥75 / small≥60），由 scorer log 印出實際 tier。
  const passLabel = '依市值分級門檻（見上方 tier 行）';
  console.log('\n╔══════════════════════════════════════╗');
  console.log(`║  Initial MAX Score: ${ticker.padEnd(6)} ${String(score.total).padStart(3)}/100        ║`);
  console.log('╚══════════════════════════════════════╝');
  console.log(`  環境 (20pts): ${score.環境.score}`);
  console.log(`  生意 (35pts): ${score.生意.score}`);
  console.log(`  組織 (20pts): ${score.組織.score}`);
  console.log(`  人   (25pts): ${score.人.score}`);
  console.log(`  達標 (${passLabel}): ${score.passThreshold ? '✓ YES' : '✗ NO'}`);
  if (score.環境.gaps.length) console.log('\n環境缺口:', score.環境.gaps.join('; '));
  if (score.生意.gaps.length) console.log('生意缺口:', score.生意.gaps.join('; '));
  if (score.組織.gaps.length) console.log('組織缺口:', score.組織.gaps.join('; '));
  if (score.人.gaps.length) console.log('人缺口:', score.人.gaps.join('; '));
}

const _entry = process.argv[1] ?? '';
if (_entry.includes('initial-max-scorer')) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
