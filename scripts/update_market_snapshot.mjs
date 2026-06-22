import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'C:\\Users\\機動小隊\\TaiEquityautoresearch';

function quarterFromDate(d = new Date()) {
  return `${d.getFullYear()} Q${Math.floor(d.getMonth() / 3) + 1}`;
}

function formatPct(value) {
  if (value == null || value === '' || Number.isNaN(Number(value))) return 'N/A';
  return `${Number(value).toFixed(2)}%`;
}

function formatMultiple(value) {
  if (value == null || value === '' || value === '-') return 'N/A';
  return `${value}x`;
}

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: {
      'user-agent': 'Mozilla/5.0',
      'accept': 'application/json,text/plain,*/*',
    },
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} for ${url}`);
  }
  return res.json();
}

async function fetchTwseSnapshot(ticker) {
  const date = new Date().toISOString().slice(0, 10).replaceAll('-', '');
  const [valuation, stockDay] = await Promise.all([
    fetchJson(`https://www.twse.com.tw/rwd/zh/afterTrading/BWIBBU?date=${date}&stockNo=${ticker}&response=json`),
    fetchJson(`https://www.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY?date=${date}&stockNo=${ticker}&response=json`),
  ]);

  const val = valuation?.data?.at(-1);
  const day = stockDay?.data?.at(-1);
  return {
    valuationDate: val?.[0] ?? 'N/A',
    dividendYield: val?.[1] ?? 'N/A',
    pe: val?.[3] ?? 'N/A',
    pb: val?.[4] ?? 'N/A',
    fiscalPeriod: val?.[5] ?? 'N/A',
    tradeDate: day?.[0] ?? 'N/A',
    volume: day?.[1] ?? 'N/A',
    turnover: day?.[2] ?? 'N/A',
    open: day?.[3] ?? 'N/A',
    high: day?.[4] ?? 'N/A',
    low: day?.[5] ?? 'N/A',
    close: day?.[6] ?? 'N/A',
    change: day?.[7] ?? 'N/A',
    trades: day?.[8] ?? 'N/A',
  };
}

function buildSection(ticker, snapshot) {
  const updatedAt = new Date();
  const stamp = `${updatedAt.getFullYear()}-${String(updatedAt.getMonth() + 1).padStart(2, '0')}-${String(updatedAt.getDate()).padStart(2, '0')} ${String(updatedAt.getHours()).padStart(2, '0')}:${String(updatedAt.getMinutes()).padStart(2, '0')}`;

  return [
    '## 市場估值快照（自動連網更新）',
    '',
    `- 更新時間：\`${stamp}\``,
    `- 公司 / 代號：\`熙特爾新能源\` / \`${ticker}\``,
    '- 掛牌別：`上市 (TWSE 創新板)`',
    '- 產業：`綠能環保 / 儲能系統整合`',
    `- 對應觀察季度：\`${quarterFromDate(updatedAt)}\``,
    `- 最新交易日：\`${snapshot.tradeDate}\``,
    `- TWSE 財報基準：\`${snapshot.fiscalPeriod}\``,
    '',
    '| 指標 | 最新值 |',
    '|------|--------|',
    `| 目前股價 | NT$ ${snapshot.close} |`,
    `| 當日漲跌 | ${snapshot.change} |`,
    `| 當日成交股數 | ${snapshot.volume} |`,
    `| 當日成交金額 | NT$ ${snapshot.turnover} |`,
    `| 當日區間 | NT$ ${snapshot.low} – ${snapshot.high} |`,
    `| 本益比 P/E | ${formatMultiple(snapshot.pe)} |`,
    `| 本淨比 P/B | ${formatMultiple(snapshot.pb)} |`,
    `| 現金殖利率 | ${formatPct(snapshot.dividendYield)} |`,
    `| 評價財報基準 | ${snapshot.fiscalPeriod} |`,
    '',
    '**市場解讀：**',
    `1. 本節為 \`自動連網更新\` 的市場快照，更新時間為 \`${stamp}\`。資料直接抓取官方 \`TWSE\` 端點，用來補足長文報告中最容易過期的市場數字。`,
    `2. 截至 \`${snapshot.tradeDate}\`，市場給予熙特爾的即時評價約為 \`P/E ${snapshot.pe}x\`、\`P/B ${snapshot.pb}x\`。這代表市場已不只在交易「儲能題材」，而是在用最新收盤價對應最近財報基準 \`${snapshot.fiscalPeriod}\` 重新定價。`,
    '3. 這一節應和正文一起看：若後續股價漲幅明顯快於案場認列與 EPS 擴張，估值風險會先浮現；若基本面持續落地而倍數仍壓低，才代表風險報酬比開始改善。',
    '',
    '（資料來源：TWSE 官方 API；本節適合每次重跑報告前更新一次。）',
    '',
  ].join('\n');
}

async function updateReport(ticker) {
  const reportPath = path.join(ROOT, 'data', 'companies', ticker, `${ticker}_Initial_MAX.md`);
  let content = fs.readFileSync(reportPath, 'utf8');
  const snapshot = await fetchTwseSnapshot(ticker);
  const section = buildSection(ticker, snapshot);

  const heading = '## 市場估值快照（自動連網更新）';
  if (content.includes(heading)) {
    const firstIdx = content.indexOf(heading);
    const before = content.slice(0, firstIdx);
    const afterCandidates = content.slice(firstIdx).split('\n## ');
    const remainder = afterCandidates
      .filter((part, idx) => idx > 0 && !part.startsWith('市場估值快照（自動連網更新）'))
      .map(part => `## ${part}`)
      .join('\n');
    content = `${before}${remainder ? remainder : ''}`.replace(/\n{3,}/g, '\n\n');
  }

  const anchor = '## 評分總表';
  const updated = content.includes(anchor)
    ? content.replace(anchor, `${section}\n${anchor}`)
    : `${content.trimEnd()}\n\n${section}`;
  fs.writeFileSync(reportPath, updated, 'utf8');
  console.log(`[ok] updated market snapshot: ${reportPath}`);
}

const ticker = process.argv[2] || '7740';
await updateReport(ticker);
