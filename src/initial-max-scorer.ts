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
import { chat } from './llm.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

const PASS_TOTAL = 95;
const MIN_環境 = 16;
const MIN_生意 = 30;
const MIN_組織 = 16;
const MIN_人 = 20;

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
  for (const id of REQUIRED_SECTIONS) {
    const re = new RegExp(`^##\\s*${id.replace('.', '\\.')}\\b.*$`, 'm');
    const match = mainContent.match(re);
    if (!match || match.index == null) {
      missing.push(id);
      continue;
    }
    const sectionStart = match.index! + match[0].length;
    const after = mainContent.slice(sectionStart);
    const nextHeading = after.match(/\n##\s/m);
    const sectionEnd = nextHeading && nextHeading.index != null ? sectionStart + nextHeading.index : mainContent.length;
    const body = mainContent.slice(sectionStart, sectionEnd).replace(/\s+/g, ' ').trim();
    if (body.length < MIN_SECTION_CHARS || /^待補充\s*$/i.test(body)) missing.push(id);
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

function heuristicScore(ticker: string): InitialMaxScore {
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
    total >= PASS_TOTAL &&
    環境Score >= MIN_環境 &&
    生意Score >= MIN_生意 &&
    組織Score >= MIN_組織 &&
    人Score >= MIN_人 &&
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

### 四、人 (25分，最低 20 才達標)
- CEO格局觀與商業哲學（多年敘事，第一性原理決策邏輯）：0-5分
- 道德操守與價值創造驅動力（具體案例佐證，非泛泛描述）：0-5分
- 公開訪談**≥25篇**+逐字稿已下載至transcripts/：0-15分 [計算公式：min(訪談數/25, 1.0)×15]

## 嚴格扣分規則（必遵）
- **無出處的數字一律不計分**：TAM、市占、營收、地理分部等未標年報/法說出處則該項扣分。
- **出處應可驗證**：在通常可取得公開連結的情境下（年報、法說、新聞、訪談），若僅寫來源名稱或檔名而**無 \`http(s)\` 連結**，該條出處從嚴扣分；已附可點擊連結者從寬。
- **每個子點（1.1～4.1）須至少 5 則管理層直接引述**（引號「…」或 "…" + 出處+日期）；不足 5 則或為間接描述者，扣該維度分。
- **CEO 引言**：僅計**直接引述**（有引號包住）；間接描述、轉述、無出處者不計入則數且扣分。
- **訪談**：只計有實際 URL 的條目；滿分門檻為 ≥25 篇。
- 從嚴給分：可給可不給時給較低分；缺關鍵元素明顯扣分。

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

async function llmScore(
  ticker: string,
  reportContent: string,
  model = 'google/gemini-3.1-pro-preview',
): Promise<InitialMaxScore | null> {
  const userMessage = `請評分以下 ${ticker} 的研究報告：

${reportContent.slice(0, 80000)}`;

  try {
    const response = await chat(
      [
        { role: 'system', content: SCORER_SYSTEM_PROMPT },
        { role: 'user', content: userMessage },
      ],
      { model, maxTokens: 4096 },
    );

    if (!response.content) return null;

    let jsonStr = response.content.trim();
    const fenceMatch = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
    if (fenceMatch) jsonStr = fenceMatch[1].trim();

    // Find outermost JSON object
    const start = jsonStr.indexOf('{');
    if (start === -1) return null;
    let depth = 0;
    let end = -1;
    for (let i = start; i < jsonStr.length; i++) {
      if (jsonStr[i] === '{') depth++;
      else if (jsonStr[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    if (end === -1) return null;

    const parsed = JSON.parse(jsonStr.slice(start, end + 1));
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
      total >= PASS_TOTAL &&
      環境 >= MIN_環境 &&
      生意 >= MIN_生意 &&
      組織 >= MIN_組織 &&
      人 >= MIN_人;

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
  model = 'google/gemini-3.1-pro-preview',
): Promise<{ score: InitialMaxScore; gaps: InitialMaxGaps }> {
  const reportContent = readResearchFiles(ticker);
  const dir = getCompanyDir(ticker);

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
    // ── #4 補強：LLM 失敗改重試（最多 2 次），不降級至 heuristic ──
    const LLM_MAX_RETRIES = 2;
    let llmResult = null;
    for (let attempt = 1; attempt <= LLM_MAX_RETRIES; attempt++) {
      console.log(`[scorer] Running LLM scorer (${model}) for ${ticker}... (attempt ${attempt}/${LLM_MAX_RETRIES})`);
      llmResult = await llmScore(ticker, reportContent, model);
      if (llmResult) break;
      if (attempt < LLM_MAX_RETRIES) {
        console.warn(`[scorer] LLM attempt ${attempt} failed, retrying in 5s...`);
        await new Promise(r => setTimeout(r, 5_000));
      }
    }

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
      // ── #4 補強：兩次重試皆失敗 → 回傳零分並標記，不用 heuristic 干擾 plateau 判斷 ──
      console.error('[scorer] LLM scorer failed after all retries. Returning zero score to avoid heuristic noise.');
      score = {
        環境: { score: 0, max: 20, gaps: ['LLM scorer 失敗（已重試 2 次），本輪分數不計入 plateau 判斷'] },
        生意: { score: 0, max: 35, gaps: ['LLM scorer 失敗'] },
        組織: { score: 0, max: 20, gaps: ['LLM scorer 失敗'] },
        人: { score: 0, max: 25, gaps: ['LLM scorer 失敗'] },
        total: -1, // ← 負值作為「本輪評分無效」的旗標，runner 端判斷
        passThreshold: false,
        round,
      };
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

  const model = args.model ?? 'google/gemini-3.1-pro-preview';
  const round = parseInt(args.round ?? '0', 10);

  const { score } = await scoreCompanyResearch(ticker.toUpperCase(), round, model);

  console.log('\n╔══════════════════════════════════════╗');
  console.log(`║  Initial MAX Score: ${ticker.padEnd(6)} ${String(score.total).padStart(3)}/100        ║`);
  console.log('╚══════════════════════════════════════╝');
  console.log(`  環境 (20pts): ${score.環境.score}`);
  console.log(`  生意 (35pts): ${score.生意.score}`);
  console.log(`  組織 (20pts): ${score.組織.score}`);
  console.log(`  人   (25pts): ${score.人.score}`);
  console.log(`  達標 (≥95 且各維度達標): ${score.passThreshold ? '✓ YES' : '✗ NO'}`);
  if (score.環境.gaps.length) console.log('\n環境缺口:', score.環境.gaps.join('; '));
  if (score.生意.gaps.length) console.log('生意缺口:', score.生意.gaps.join('; '));
  if (score.組織.gaps.length) console.log('組織缺口:', score.組織.gaps.join('; '));
  if (score.人.gaps.length) console.log('人缺口:', score.人.gaps.join('; '));
}

const _entry = process.argv[1] ?? '';
if (_entry.includes('initial-max-scorer')) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
