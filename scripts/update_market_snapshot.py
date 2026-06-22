#!/usr/bin/env python3
"""
Fetch live market snapshot for a Taiwan stock and inject/update a markdown section.

Usage:
    python scripts/update_market_snapshot.py 7740 TW
"""
from __future__ import annotations

import re
import json
import subprocess
import sys
from datetime import datetime
from pathlib import Path

from fetch_financials import fetch_financials


ROOT = Path(r"C:\Users\機動小隊\TaiEquityautoresearch")
REPORT_DIR = ROOT / "data" / "companies"


def run_pwsh_json(command: str) -> dict:
    result = subprocess.run(
        [
            r"C:\Program Files\PowerShell\7\pwsh.exe",
            "-Command",
            command,
        ],
        capture_output=True,
        text=True,
        encoding="utf-8",
        check=True,
    )
    return json.loads(result.stdout)


def fetch_twse_snapshot(ticker: str) -> dict:
    date = datetime.now().strftime("%Y%m%d")

    bwibbu_cmd = (
        f"$r=Invoke-RestMethod -Uri "
        f"'https://www.twse.com.tw/rwd/zh/afterTrading/BWIBBU?date={date}&stockNo={ticker}&response=json' "
        f"-TimeoutSec 30 -SkipCertificateCheck; $r | ConvertTo-Json -Depth 5"
    )
    stock_day_cmd = (
        f"$r=Invoke-RestMethod -Uri "
        f"'https://www.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY?date={date}&stockNo={ticker}&response=json' "
        f"-TimeoutSec 30 -SkipCertificateCheck; $r | ConvertTo-Json -Depth 5"
    )

    valuation = run_pwsh_json(bwibbu_cmd)
    daily = run_pwsh_json(stock_day_cmd)

    latest_val = valuation.get("data", [])[-1] if valuation.get("data") else None
    latest_day = daily.get("data", [])[-1] if daily.get("data") else None

    snapshot = {
        "valuation_date": latest_val[0] if latest_val else None,
        "dividend_yield": latest_val[1] if latest_val else None,
        "dividend_year": latest_val[2] if latest_val else None,
        "pe": latest_val[3] if latest_val else None,
        "pb": latest_val[4] if latest_val else None,
        "fiscal_period": latest_val[5] if latest_val else None,
        "trade_date": latest_day[0] if latest_day else None,
        "volume": latest_day[1] if latest_day else None,
        "turnover": latest_day[2] if latest_day else None,
        "open": latest_day[3] if latest_day else None,
        "high": latest_day[4] if latest_day else None,
        "low": latest_day[5] if latest_day else None,
        "close": latest_day[6] if latest_day else None,
        "change": latest_day[7] if latest_day else None,
        "trades": latest_day[8] if latest_day else None,
    }
    return snapshot


def quarter_from_date(dt: datetime) -> str:
    q = (dt.month - 1) // 3 + 1
    return f"{dt.year} Q{q}"


def build_section(ticker: str, market: str) -> str:
    twse = fetch_twse_snapshot(ticker)
    fin = fetch_financials(ticker, market)
    now = datetime.now()
    updated_at = now.strftime("%Y-%m-%d %H:%M")
    report_q = quarter_from_date(now)

    price = f"NT$ {twse['close']}" if twse.get("close") else fin.fmt_price()
    mktcap = fin.fmt_mktcap()
    pe = f"{twse['pe']}x" if twse.get("pe") else fin.fmt_pe()
    pb = f"{twse['pb']}x" if twse.get("pb") else fin.fmt_pb()
    dividend_yield = f"{twse['dividend_yield']}%" if twse.get("dividend_yield") else "N/A"
    peg = fin.fmt_peg()
    roe = fin.fmt_roe()
    rev_growth = fin.fmt_revenue_growth()
    trailing_eps = fin.fmt_trailing_eps()
    eps_quarters = fin.fmt_eps_quarters()
    week52 = fin.fmt_52w()
    company = fin.company_name or f"{ticker}"
    sector = fin.sector or "N/A"
    market_type = fin.market_type or market
    trade_date = twse.get("trade_date") or "N/A"
    latest_change = twse.get("change") or "N/A"
    latest_volume = twse.get("volume") or "N/A"
    latest_high = twse.get("high") or "N/A"
    latest_low = twse.get("low") or "N/A"
    fiscal_period = twse.get("fiscal_period") or "N/A"

    commentary = [
        f"本節為 `自動連網更新` 的市場快照，更新時間為 `{updated_at}`。`收盤價 / 漲跌 / 成交量 / 本益比 / 本淨比 / 殖利率` 以官方 `TWSE` 為主，其他補充欄位以 `Yahoo Finance / yfinance` 為備援。",
        f"以 `{company}` 目前可抓到的資料來看，市場正在用 `股價 / 本益比 / 本淨比 / 殖利率 / 成交量` 這些即時指標重新定價公司，而不是只看年報與法說簡報。",
        "這一節應和正文的基本面判斷一起看：若後續股價漲幅大幅超過 EPS 與案場認列速度，估值風險就會先於基本面浮現；反之，若認列落地而估值倍數仍壓低，才代表風險報酬比開始改善。",
    ]

    lines = [
        "## 市場估值快照（自動連網更新）",
        "",
        f"- 更新時間：`{updated_at}`",
        f"- 公司 / 代號：`{company}` / `{ticker}`",
        f"- 掛牌別：`{market_type}`",
        f"- 產業：`{sector}`",
        f"- 對應觀察季度：`{report_q}`",
        f"- 最新交易日：`{trade_date}`",
        f"- TWSE 財報基準：`{fiscal_period}`",
        "",
        "| 指標 | 最新值 |",
        "|------|--------|",
        f"| 目前股價 | {price} |",
        f"| 當日漲跌 | {latest_change} |",
        f"| 當日成交股數 | {latest_volume} |",
        f"| 當日區間 | NT$ {latest_low} – {latest_high} |",
        f"| 市值 | {mktcap} |",
        f"| 本益比 P/E | {pe} |",
        f"| 本淨比 P/B | {pb} |",
        f"| 現金殖利率 | {dividend_yield} |",
        f"| 本益成長比 PEG | {peg} |",
        f"| ROE | {roe} |",
        f"| TTM 營收成長 | {rev_growth} |",
        f"| Trailing EPS | {trailing_eps} |",
        f"| 最近季度 EPS | {eps_quarters} |",
        f"| 52 週股價區間 | NT$ {week52} |",
        "",
        "**市場解讀：**",
        f"1. {commentary[0]}",
        f"2. {commentary[1]}",
        f"3. {commentary[2]}",
        "",
        "（資料來源：TWSE 官方 API 與 Yahoo Finance / `yfinance`；本節適合每次重跑報告前更新一次。）",
        "",
    ]
    return "\n".join(lines)


def update_report(ticker: str, market: str) -> Path:
    report_path = REPORT_DIR / ticker / f"{ticker}_Initial_MAX.md"
    if not report_path.exists():
        raise FileNotFoundError(f"Report not found: {report_path}")

    content = report_path.read_text(encoding="utf-8")
    section = build_section(ticker, market)

    pattern = re.compile(
        r"## 市場估值快照（自動連網更新）\n.*?(?=\n## |\Z)",
        re.S,
    )

    if pattern.search(content):
        updated = pattern.sub(section.rstrip() + "\n", content)
    else:
        anchor = "## 評分總表"
        if anchor in content:
            updated = content.replace(anchor, section + "\n" + anchor, 1)
        else:
            updated = content + "\n\n" + section

    report_path.write_text(updated, encoding="utf-8")
    return report_path


def main() -> int:
    ticker = sys.argv[1] if len(sys.argv) > 1 else "7740"
    market = sys.argv[2] if len(sys.argv) > 2 else "TW"
    path = update_report(ticker, market)
    print(f"[ok] updated market snapshot: {path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
