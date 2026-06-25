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
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

try:
    import yfinance as yf
    HAS_YFINANCE = True
except ImportError:
    HAS_YFINANCE = False
    print('[fetch_financials] yfinance not installed — pip install yfinance')


def _init_ca_bundle() -> None:
    """
    Make yfinance/curl_cffi trust SSL-intercepted connections (e.g. Norton /
    ESET / corporate proxy doing TLS scanning) by merging the Windows
    certificate store roots into certifi's bundle and pointing the HTTP
    clients at the combined file via env vars.

    Without this, curl_cffi fails with:
        curl: (60) SSL certificate problem: unable to get local issuer certificate
    because the interceptor's root CA lives only in the Windows store, not in certifi.
    """
    import ssl
    # ssl.enum_certificates is Windows-only; harmless no-op elsewhere.
    if not hasattr(ssl, 'enum_certificates'):
        return
    try:
        import certifi
        cache_dir = Path(__file__).resolve().parents[1] / '.cache'
        cache_dir.mkdir(parents=True, exist_ok=True)
        bundle = cache_dir / 'win-ca-bundle.pem'

        pem_parts = []
        for store in ('ROOT', 'CA'):
            try:
                for cert_bytes, enc, _trust in ssl.enum_certificates(store):
                    if enc == 'x509_asn':
                        pem_parts.append(ssl.DER_cert_to_PEM_cert(cert_bytes))
            except Exception:
                continue

        if pem_parts:
            bundle.write_text(
                certifi.contents() + '\n' + '\n'.join(pem_parts),
                encoding='utf-8',
            )
            # curl_cffi honours CURL_CA_BUNDLE; requests honours REQUESTS_CA_BUNDLE;
            # stdlib ssl honours SSL_CERT_FILE.
            os.environ['CURL_CA_BUNDLE']     = str(bundle)
            os.environ['REQUESTS_CA_BUNDLE'] = str(bundle)
            os.environ.setdefault('SSL_CERT_FILE', str(bundle))
    except Exception as e:
        print(f'[fetch_financials] CA bundle init warning: {e}')


def _init_yfinance_cache() -> None:
    """Point yfinance cache at a writable local directory on Windows."""
    if not HAS_YFINANCE:
        return
    try:
        default_cache = Path(__file__).resolve().parents[1] / '.cache' / 'yfinance'
        cache_dir = Path(os.getenv('YFINANCE_CACHE_DIR', str(default_cache)))
        cache_dir.mkdir(parents=True, exist_ok=True)
        if hasattr(yf, 'set_tz_cache_location'):
            yf.set_tz_cache_location(str(cache_dir))
    except Exception as e:
        print(f'[fetch_financials] cache init warning: {e}')


_init_ca_bundle()
_init_yfinance_cache()


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

    # ── EPS 成長率計算（三層優先順序）────────────────────────────────────────────
    # 1. 優先：最近 4 季 NI vs 前 4 季 NI（興櫃只取 Q2/Q4 兩季比較）
    # 2. 備用：最近年度 vs 前一年度（年報比較）
    # 3. 最後：Yahoo Finance earningsGrowth（最不準，單季 YoY）
    # GOODinfo 用年度 EPS 成長率，以此方法計算 PEG 與其一致。
    computed_growth: float | None = None

    try:
        qi = t.quarterly_income_stmt
        if qi is not None and not qi.empty and 'Net Income' in qi.index:
            ni_row = qi.loc['Net Income']
            # 取所有有效季度，按時間降序排列
            all_q = sorted(
                [(ts, _safe(v)) for ts, v in ni_row.items() if _safe(v) is not None],
                reverse=True
            )
            # 篩出 Q2（6月）與 Q4（12月）─ 興櫃的申報季
            q2q4 = [(ts, v) for ts, v in all_q if ts.month in (6, 12)]

            if len(q2q4) >= 4:
                # 最近 Q2+Q4 vs 前一年 Q2+Q4
                recent = q2q4[0][1] + q2q4[1][1]
                prior  = q2q4[2][1] + q2q4[3][1]
                if prior > 0:
                    computed_growth = (recent - prior) / prior
                    data._growth_method = 'Q2+Q4 YoY'
            elif len(all_q) >= 8:
                # 足夠 8 季 → 滾動 TTM vs 前年 TTM
                recent_ttm = sum(v for _, v in all_q[:4])
                prior_ttm  = sum(v for _, v in all_q[4:8])
                if prior_ttm > 0:
                    computed_growth = (recent_ttm - prior_ttm) / prior_ttm
                    data._growth_method = 'TTM YoY'
    except Exception:
        pass

    # 備用：年度報表比較
    if computed_growth is None:
        try:
            ai = t.income_stmt
            if ai is not None and not ai.empty and 'Net Income' in ai.index:
                ni = ai.loc['Net Income']
                cols = sorted(
                    [c for c in ni.index if _safe(ni[c]) is not None],
                    reverse=True
                )
                if len(cols) >= 2:
                    ni_new = _safe(ni[cols[0]])
                    ni_old = _safe(ni[cols[1]])
                    if ni_old and ni_old > 0 and ni_new:
                        computed_growth = (ni_new - ni_old) / abs(ni_old)
                        data._growth_method = 'Annual YoY'
        except Exception:
            pass

    if computed_growth and computed_growth > 0:
        data.earnings_growth = computed_growth
        if data.trailing_pe:
            data.peg_ratio = data.trailing_pe / (computed_growth * 100)
    elif data.trailing_pe and data.earnings_growth and data.earnings_growth > 0:
        # 最後備用：Yahoo 原始 earningsGrowth（單季 YoY，較不準）
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
