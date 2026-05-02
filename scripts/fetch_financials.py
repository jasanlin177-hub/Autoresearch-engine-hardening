#!/usr/bin/env python3
"""
Fetch key financial metrics for a Taiwan stock via yfinance.
Returns a FinancialData dataclass. All fields are None when unavailable.

Usage:
    from fetch_financials import fetch_financials
    data = fetch_financials('7738', market='TWO')   # TWO = 興櫃/上櫃, TW = 上市
    print(data)
"""
from __future__ import annotations
import math
from dataclasses import dataclass, field
from typing import Optional

try:
    import yfinance as yf
    HAS_YFINANCE = True
except ImportError:
    HAS_YFINANCE = False
    print('[fetch_financials] yfinance not installed — pip install yfinance')


@dataclass
class FinancialData:
    ticker:           str
    company_name:     Optional[str]  = None
    sector:           Optional[str]  = None
    market_type:      str            = ''        # 上市 / 上櫃 / 興櫃

    # Price
    price:            Optional[float] = None
    market_cap_b:     Optional[float] = None     # 市值（億元）
    week52_high:      Optional[float] = None
    week52_low:       Optional[float] = None

    # Valuation
    trailing_pe:      Optional[float] = None
    forward_pe:       Optional[float] = None
    price_to_book:    Optional[float] = None
    peg_ratio:        Optional[float] = None     # 本益成長比

    # Earnings (EPS)
    trailing_eps:     Optional[float] = None     # TTM EPS
    forward_eps:      Optional[float] = None
    eps_quarters:     list = field(default_factory=list)  # [(date_str, eps), ...]

    # Growth & Returns
    revenue_growth:   Optional[float] = None     # YoY 營收成長率（小數）
    earnings_growth:  Optional[float] = None     # YoY EPS 成長率（小數）
    roe:              Optional[float] = None     # 股東權益報酬率（小數）
    operating_margin: Optional[float] = None

    # Revenue (annual TTM)
    total_revenue_b:  Optional[float] = None     # 億元

    def fmt_price(self) -> str:
        return f'NT$ {self.price:,.2f}' if self.price else 'N/A'

    def fmt_mktcap(self) -> str:
        return f'NT$ {self.market_cap_b:.2f} 億' if self.market_cap_b else 'N/A'

    def fmt_pct(self, val: Optional[float], sign=True) -> str:
        if val is None:
            return 'N/A'
        s = f'{val*100:+.1f}%' if sign else f'{val*100:.1f}%'
        return s

    def fmt_pe(self) -> str:
        return f'{self.trailing_pe:.1f}x' if self.trailing_pe else 'N/A'

    def fmt_peg(self) -> str:
        return f'{self.peg_ratio:.2f}' if self.peg_ratio else 'N/A'

    def fmt_pb(self) -> str:
        return f'{self.price_to_book:.2f}x' if self.price_to_book else 'N/A'

    def fmt_roe(self) -> str:
        return self.fmt_pct(self.roe, sign=False)

    def fmt_revenue_growth(self) -> str:
        return self.fmt_pct(self.revenue_growth, sign=True)

    def fmt_trailing_eps(self) -> str:
        return f'{self.trailing_eps:.2f}' if self.trailing_eps else 'N/A'

    def fmt_52w(self) -> str:
        if self.week52_high and self.week52_low:
            return f'{self.week52_low:,.1f} – {self.week52_high:,.1f}'
        return 'N/A'

    def fmt_eps_quarters(self) -> str:
        """最近季度 EPS 字串，如 Q4: 3.03 / Q2: 4.55"""
        if not self.eps_quarters:
            return 'N/A'
        parts = [f'{d}: {v:.2f}' for d, v in self.eps_quarters[:4]]
        return '　'.join(parts)


def _safe(val):
    """Return None if val is NaN/None."""
    if val is None:
        return None
    try:
        if math.isnan(float(val)):
            return None
        return float(val)
    except (TypeError, ValueError):
        return None


def fetch_financials(ticker: str, market: str = 'TWO') -> FinancialData:
    """
    Fetch financial data for a Taiwan stock.
    market: 'TWO' (興櫃/上櫃) or 'TW' (上市 TWSE)
    """
    if not HAS_YFINANCE:
        return FinancialData(ticker=ticker)

    symbol = f'{ticker}.{market}'
    try:
        t = yf.Ticker(symbol)
        info = t.info or {}
    except Exception as e:
        print(f'[fetch_financials] yfinance error for {symbol}: {e}')
        return FinancialData(ticker=ticker)

    # Market type label
    market_labels = {'TWO': '上櫃 / 興櫃', 'TW': '上市 (TWSE)'}

    data = FinancialData(
        ticker        = ticker,
        company_name  = info.get('longName') or info.get('shortName'),
        sector        = info.get('industry') or info.get('sector'),
        market_type   = market_labels.get(market, market),

        price         = _safe(info.get('currentPrice') or info.get('regularMarketPrice')),
        week52_high   = _safe(info.get('fiftyTwoWeekHigh')),
        week52_low    = _safe(info.get('fiftyTwoWeekLow')),

        trailing_pe   = _safe(info.get('trailingPE')),
        forward_pe    = _safe(info.get('forwardPE')),
        price_to_book = _safe(info.get('priceToBook')),

        trailing_eps  = _safe(info.get('trailingEps')),
        forward_eps   = _safe(info.get('forwardEps')),

        revenue_growth   = _safe(info.get('revenueGrowth')),
        earnings_growth  = _safe(info.get('earningsGrowth')),
        roe              = _safe(info.get('returnOnEquity')),
        operating_margin = _safe(info.get('operatingMargins')),
    )

    # Market cap in 億 NTD
    mc = _safe(info.get('marketCap'))
    if mc:
        data.market_cap_b = mc / 1e8

    # PEG ratio: prefer yfinance value, else compute
    peg = _safe(info.get('pegRatio'))
    if peg:
        data.peg_ratio = peg
    elif data.trailing_pe and data.earnings_growth and data.earnings_growth > 0:
        data.peg_ratio = data.trailing_pe / (data.earnings_growth * 100)

    # Total revenue in 億
    rev = _safe(info.get('totalRevenue'))
    if rev:
        data.total_revenue_b = rev / 1e8

    # Quarterly EPS — use earnings_history + quarterly income stmt
    try:
        eh = t.earnings_history
        if eh is not None and not eh.empty and 'epsActual' in eh.columns:
            rows = []
            for idx, row in eh.iterrows():
                eps_val = _safe(row.get('epsActual'))
                if eps_val is None:
                    continue
                # idx is Timestamp
                try:
                    q_label = _quarter_label(idx)
                except Exception:
                    q_label = str(idx)[:7]
                rows.append((q_label, eps_val))
            data.eps_quarters = rows[:4]
    except Exception:
        pass

    # If no earnings_history, estimate from quarterly net income / shares
    if not data.eps_quarters:
        try:
            qi = t.quarterly_income_stmt
            shares = None
            if data.trailing_eps and data.total_revenue_b:
                ni_ttm = _safe(info.get('netIncomeToCommon'))
                if ni_ttm and data.trailing_eps:
                    shares = ni_ttm / data.trailing_eps

            if shares and qi is not None and not qi.empty and 'Net Income' in qi.index:
                ni_row = qi.loc['Net Income']
                rows = []
                for ts, ni in ni_row.items():
                    v = _safe(ni)
                    if v is None:
                        continue
                    eps_q = v / shares
                    rows.append((_quarter_label(ts), round(eps_q, 2)))
                data.eps_quarters = rows[:4]
        except Exception:
            pass

    return data


def _quarter_label(ts) -> str:
    """Convert timestamp to 'YYYY Qn' label."""
    try:
        import pandas as pd
        ts = pd.Timestamp(ts)
        m = ts.month
        if m <= 3:   q = 'Q1'
        elif m <= 6: q = 'Q2'
        elif m <= 9: q = 'Q3'
        else:        q = 'Q4'
        return f'{ts.year} {q}'
    except Exception:
        return str(ts)[:7]


if __name__ == '__main__':
    import sys
    tkr = sys.argv[1] if len(sys.argv) > 1 else '7738'
    mkt = sys.argv[2] if len(sys.argv) > 2 else 'TWO'
    d = fetch_financials(tkr, mkt)
    print(f'\n=== {tkr}.{mkt} 財務摘要 ===')
    print(f'  股價      : {d.fmt_price()}')
    print(f'  市值      : {d.fmt_mktcap()}')
    print(f'  52週高低  : {d.fmt_52w()}')
    print(f'  本益比    : {d.fmt_pe()}')
    print(f'  本淨比    : {d.fmt_pb()}')
    print(f'  本益成長比: {d.fmt_peg()}')
    print(f'  ROE       : {d.fmt_roe()}')
    print(f'  TTM營收成長: {d.fmt_revenue_growth()}')
    print(f'  Trailing EPS: {d.fmt_trailing_eps()}')
    print(f'  季度EPS   : {d.fmt_eps_quarters()}')
