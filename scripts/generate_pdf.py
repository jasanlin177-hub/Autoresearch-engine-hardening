#!/usr/bin/env python3
"""
Generate a formatted PDF report from a TaiEquityautoresearch Markdown file.
Supports Traditional Chinese, tables, headers, blockquotes, financial cover page.
"""
import re
import os
import sys
from datetime import datetime
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.lib import colors
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle,
    HRFlowable, KeepTogether, PageBreak
)
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont

# ── Load financial data module ────────────────────────────────────────────────
_SCRIPTS_DIR = os.path.dirname(os.path.abspath(__file__))
if _SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, _SCRIPTS_DIR)
try:
    from fetch_financials import fetch_financials, FinancialData
    HAS_FINANCIALS = True
except ImportError:
    HAS_FINANCIALS = False

# ── Font Registration (Traditional Chinese) ──────────────────────────────────
FONT_PATH = r"C:\Windows\Fonts\msjh.ttc"
FONT_BOLD_PATH = r"C:\Windows\Fonts\msjhbd.ttc"

pdfmetrics.registerFont(TTFont("MSJH", FONT_PATH, subfontIndex=0))
try:
    pdfmetrics.registerFont(TTFont("MSJH-Bold", FONT_BOLD_PATH, subfontIndex=0))
    BOLD_FONT = "MSJH-Bold"
except Exception:
    BOLD_FONT = "MSJH"

# ── Styles ────────────────────────────────────────────────────────────────────
def make_styles():
    base = dict(fontName="MSJH", leading=18)
    bold = dict(fontName=BOLD_FONT, leading=18)
    return {
        "title": ParagraphStyle("title", fontSize=20, leading=28,
                                 fontName=BOLD_FONT, spaceAfter=6,
                                 textColor=colors.HexColor("#1a1a2e")),
        "h1": ParagraphStyle("h1", fontSize=15, leading=22,
                              fontName=BOLD_FONT, spaceBefore=14, spaceAfter=4,
                              textColor=colors.HexColor("#16213e"),
                              borderPad=2),
        "h2": ParagraphStyle("h2", fontSize=13, leading=20,
                              fontName=BOLD_FONT, spaceBefore=10, spaceAfter=3,
                              textColor=colors.HexColor("#0f3460")),
        "h3": ParagraphStyle("h3", fontSize=11, leading=18,
                              fontName=BOLD_FONT, spaceBefore=8, spaceAfter=2,
                              textColor=colors.HexColor("#533483")),
        "body": ParagraphStyle("body", fontSize=10, leading=17,
                                fontName="MSJH", spaceAfter=4,
                                textColor=colors.HexColor("#2c2c2c")),
        "quote": ParagraphStyle("quote", fontSize=10, leading=17,
                                 fontName="MSJH", spaceAfter=4,
                                 leftIndent=16, rightIndent=8,
                                 textColor=colors.HexColor("#444444"),
                                 borderColor=colors.HexColor("#888888"),
                                 borderWidth=0, borderPad=0,
                                 backColor=colors.HexColor("#f5f5f5")),
        "caption": ParagraphStyle("caption", fontSize=8, leading=12,
                                   fontName="MSJH", spaceAfter=2,
                                   textColor=colors.grey),
        "header": ParagraphStyle("header", fontSize=8, fontName="MSJH",
                                  textColor=colors.grey),
        # ── Cover page styles ──
        "cover_ticker": ParagraphStyle("cover_ticker", fontSize=18, leading=26,
                                        fontName=BOLD_FONT, spaceAfter=4,
                                        alignment=1,  # centre
                                        textColor=colors.HexColor("#ffffff")),
        "cover_company": ParagraphStyle("cover_company", fontSize=38, leading=50,
                                         fontName=BOLD_FONT, spaceAfter=6,
                                         alignment=1,
                                         textColor=colors.HexColor("#ffffff")),
        "cover_subtitle": ParagraphStyle("cover_subtitle", fontSize=16, leading=24,
                                          fontName="MSJH", spaceAfter=0,
                                          alignment=1,
                                          textColor=colors.HexColor("#a8d4f5")),
        "cover_date": ParagraphStyle("cover_date", fontSize=11, leading=18,
                                      fontName="MSJH", spaceAfter=0,
                                      alignment=1,
                                      textColor=colors.HexColor("#c0d8ee")),
        "cover_disclaimer": ParagraphStyle("cover_disclaimer", fontSize=8, leading=13,
                                            fontName="MSJH", spaceAfter=0,
                                            alignment=1,
                                            textColor=colors.HexColor("#7baabf")),
    }

# ── Markdown helpers ──────────────────────────────────────────────────────────
def escape_xml(text):
    return (text.replace("&", "&amp;")
                .replace("<", "&lt;")
                .replace(">", "&gt;"))

def apply_inline(text, styles):
    """Convert **bold** and [text](url) inline markdown."""
    # Bold
    text = re.sub(r'\*\*(.+?)\*\*',
                  lambda m: f'<font name="{BOLD_FONT}">{escape_xml(m.group(1))}</font>',
                  text)
    # Links → clickable hyperlinks in PDF
    text = re.sub(r'\[([^\]]+)\]\(([^)]+)\)',
                  lambda m: f'<a href="{escape_xml(m.group(2))}" color="#0563C1"><u>{escape_xml(m.group(1))}</u></a>',
                  text)
    return text

def is_separator(line):
    return re.match(r'^-{3,}$', line.strip())

def is_table_row(line):
    return line.strip().startswith("|") and line.strip().endswith("|")

def is_table_sep(line):
    return is_table_row(line) and re.match(r'^[\|\-\:\s]+$', line.strip())

def parse_table(lines):
    rows = []
    for line in lines:
        if is_table_sep(line):
            continue
        cells = [c.strip() for c in line.strip().strip("|").split("|")]
        rows.append(cells)
    return rows

def deduplicate_sections(text):
    """Remove duplicate H1/H2 sections — keep only the last occurrence."""
    pattern = re.compile(r'^(#{1,2} .+)$', re.MULTILINE)
    matches = list(pattern.finditer(text))
    if not matches:
        return text

    # Find section boundaries
    sections = []
    for i, m in enumerate(matches):
        start = m.start()
        end = matches[i + 1].start() if i + 1 < len(matches) else len(text)
        sections.append((m.group(1), start, end))

    # Keep last occurrence of each heading
    seen = {}
    for heading, start, end in sections:
        seen[heading] = (start, end)

    # Rebuild: include preamble, then each unique section (last occurrence)
    first_heading_start = sections[0][1]
    result = text[:first_heading_start]
    for heading, (start, end) in seen.items():
        result += text[start:end]
    return result


# ── PDF Builder ───────────────────────────────────────────────────────────────
def build_pdf(md_path, out_path):
    with open(md_path, encoding="utf-8") as f:
        raw = f.read()

    # Remove duplicate sections
    raw = deduplicate_sections(raw)
    raw = re.sub(r'（必達）', '', raw)   # 移除評分系統內部標記，不對外顯示

    W, H = A4
    margin = 20 * mm

    company      = "東聯互動（7738）深度研究報告"
    report_date  = datetime.today().strftime("%Y-%m-%d")
    CONTENT_W    = W - 2 * margin   # usable content width

    # ── Fetch live financial data ─────────────────────────────────────────────
    fin: FinancialData | None = None
    if HAS_FINANCIALS:
        try:
            print('  [cover] Fetching financial data…')
            fin = fetch_financials('7738', 'TWO')
            print(f'  [cover] 股價 {fin.fmt_price()}  市值 {fin.fmt_mktcap()}')
        except Exception as e:
            print(f'  [cover] Financial fetch failed: {e}')

    # ── Colour palette ────────────────────────────────────────────────────────
    DARK_NAVY  = colors.HexColor('#0d1b3e')
    MID_BLUE   = colors.HexColor('#1e3d6e')
    LIGHT_BLUE = colors.HexColor('#e8f0f8')
    GOLD       = colors.HexColor('#c9a84c')
    WHITE      = colors.white
    GREY_TEXT  = colors.HexColor('#7baabf')

    # ── Inline paragraph styles for cover ────────────────────────────────────
    def cov(name, size, bold=False, color=WHITE, align=1, lead=None, sb=0, sa=0):
        return ParagraphStyle(name, fontName=BOLD_FONT if bold else "MSJH",
                              fontSize=size, leading=lead or size * 1.4,
                              textColor=color, alignment=align,
                              spaceBefore=sb, spaceAfter=sa)

    s_ticker   = cov('cov_ticker', 13, color=GREY_TEXT)
    s_company  = cov('cov_company', 40, bold=True, color=WHITE, lead=52)
    s_subtitle = cov('cov_subtitle', 16, color=colors.HexColor('#a8d4f5'))
    s_info     = cov('cov_info', 10, color=colors.HexColor('#c0d8ee'), lead=16)
    s_disc     = cov('cov_disc', 7.5, color=GREY_TEXT)
    s_mhdr     = cov('cov_mhdr', 8.5, bold=True, color=WHITE,      lead=13)
    s_mval     = cov('cov_mval', 13, bold=True,  color=WHITE,       lead=18)
    s_mlbl     = cov('cov_mlbl', 8,  color=colors.HexColor('#90bcd8'), lead=12)
    s_ehdr     = cov('cov_ehdr', 8.5, bold=True, color=colors.HexColor('#1e3d6e'), lead=13)
    s_eval     = cov('cov_eval', 11, bold=True,  color=colors.HexColor('#0d1b3e'), lead=16)
    s_elbl     = cov('cov_elbl', 8,  color=colors.HexColor('#5580a0'), lead=12)

    # helper: blank spacer row
    def _blank(h=8):
        return [Paragraph('', s_disc)]

    # ── Build financial strings ───────────────────────────────────────────────
    price_str  = fin.fmt_price()    if fin else 'N/A'
    mktcap_str = fin.fmt_mktcap()  if fin else 'N/A'
    sector_str = (fin.sector or '金融科技') if fin else '金融科技'
    market_str = (fin.market_type  or '興櫃')  if fin else '興櫃'
    rev_g_str  = fin.fmt_revenue_growth() if fin else 'N/A'
    pe_str     = fin.fmt_pe()      if fin else 'N/A'
    roe_str    = fin.fmt_roe()     if fin else 'N/A'
    peg_str    = fin.fmt_peg()     if fin else 'N/A'
    pb_str     = fin.fmt_pb()      if fin else 'N/A'
    eps_str    = fin.fmt_trailing_eps() if fin else 'N/A'
    eps_q_str  = fin.fmt_eps_quarters() if fin else 'N/A'
    w52_str    = fin.fmt_52w()     if fin else 'N/A'

    # ── Table styles ─────────────────────────────────────────────────────────
    TS = TableStyle

    def _pad(t=8, b=8, l=10, r=10):
        return [('TOPPADDING',    (0,0), (-1,-1), t),
                ('BOTTOMPADDING', (0,0), (-1,-1), b),
                ('LEFTPADDING',   (0,0), (-1,-1), l),
                ('RIGHTPADDING',  (0,0), (-1,-1), r)]

    # ── Cover header table (dark-navy background, full width) ─────────────────
    hdr_rows = [
        [Paragraph('', s_disc)],                          # top pad
        [Paragraph(f'股票代號　7738　｜　{market_str}', s_ticker)],
        [Paragraph('東聯互動', s_company)],
        [Paragraph('深度研究報告', s_subtitle)],
        [Paragraph(f'目前股價：{price_str}　｜　市值：{mktcap_str}', s_info)],
        [Paragraph(f'產業：{sector_str}　｜　產出日期：{report_date}', s_info)],
        [Paragraph('', s_disc)],                          # bottom pad
    ]
    hdr_tbl = Table(hdr_rows, colWidths=[CONTENT_W])
    hdr_tbl.setStyle(TS([
        ('BACKGROUND', (0,0), (-1,-1), DARK_NAVY),
        ('ALIGN',      (0,0), (-1,-1), 'CENTER'),
        ('VALIGN',     (0,0), (-1,-1), 'MIDDLE'),
        ('TOPPADDING',    (0,0), (0,0), 22),   # top pad row
        ('BOTTOMPADDING', (0,6), (0,6), 18),   # bottom pad row
        ('TOPPADDING',    (0,1), (0,5), 4),
        ('BOTTOMPADDING', (0,1), (0,5), 4),
        ('LINEBELOW', (0,3), (0,3), 1.5, GOLD),   # gold line under subtitle
    ]))

    # ── 5-column financial metrics table ──────────────────────────────────────
    col5 = CONTENT_W / 5
    met_rows = [
        [Paragraph('TTM 營收成長', s_mhdr), Paragraph('本益比 P/E', s_mhdr),
         Paragraph('ROE', s_mhdr),          Paragraph('本益成長比 PEG', s_mhdr),
         Paragraph('本淨比 P/B', s_mhdr)],
        [Paragraph(rev_g_str, s_mval), Paragraph(pe_str, s_mval),
         Paragraph(roe_str,   s_mval), Paragraph(peg_str, s_mval),
         Paragraph(pb_str,    s_mval)],
        [Paragraph('YoY 年增率', s_mlbl), Paragraph('Trailing', s_mlbl),
         Paragraph('股東報酬', s_mlbl),    Paragraph('PE ÷ EPS成長', s_mlbl),
         Paragraph('股價淨值', s_mlbl)],
    ]
    met_tbl = Table(met_rows, colWidths=[col5]*5)
    met_tbl.setStyle(TS([
        ('BACKGROUND', (0,0), (-1,-1), MID_BLUE),
        ('ALIGN',      (0,0), (-1,-1), 'CENTER'),
        ('VALIGN',     (0,0), (-1,-1), 'MIDDLE'),
        ('GRID',       (0,0), (-1,-1), 0.3, colors.HexColor('#2d5080')),
        ('TOPPADDING',    (0,0), (-1,-1), 5),
        ('BOTTOMPADDING', (0,0), (-1,-1), 3),
    ]))

    # ── EPS / 52W row (3 columns, light background) ───────────────────────────
    col3 = CONTENT_W / 3
    eps_rows = [
        [Paragraph('Trailing EPS (TTM)', s_ehdr),
         Paragraph('最近季度 EPS', s_ehdr),
         Paragraph('52 週股價區間', s_ehdr)],
        [Paragraph(eps_str, s_eval),
         Paragraph(eps_q_str, s_eval),
         Paragraph(f'NT$ {w52_str}', s_eval)],
        [Paragraph('近12個月每股盈餘', s_elbl),
         Paragraph('興櫃：Q2 / Q4 申報', s_elbl),
         Paragraph('High – Low', s_elbl)],
    ]
    eps_tbl = Table(eps_rows, colWidths=[col3]*3)
    eps_tbl.setStyle(TS([
        ('BACKGROUND', (0,0), (-1,-1), LIGHT_BLUE),
        ('ALIGN',      (0,0), (-1,-1), 'CENTER'),
        ('VALIGN',     (0,0), (-1,-1), 'MIDDLE'),
        ('GRID',       (0,0), (-1,-1), 0.3, colors.HexColor('#b0c8e0')),
        ('TOPPADDING',    (0,0), (-1,-1), 5),
        ('BOTTOMPADDING', (0,0), (-1,-1), 3),
    ]))

    # ── Disclaimer strip ──────────────────────────────────────────────────────
    disc_tbl = Table(
        [[Paragraph('本報告由 TaiEquityautoresearch 自動生成，僅供參考，不構成投資建議。財務數據來源：Yahoo Finance。', s_disc)]],
        colWidths=[CONTENT_W])
    disc_tbl.setStyle(TS([
        ('BACKGROUND', (0,0), (-1,-1), DARK_NAVY),
        ('ALIGN',      (0,0), (-1,-1), 'CENTER'),
        ('TOPPADDING',    (0,0), (-1,-1), 6),
        ('BOTTOMPADDING', (0,0), (-1,-1), 6),
    ]))

    # ── Page callbacks (no canvas background — handled by Tables above) ────────
    def on_first_page(canvas, doc):
        """Cover page — gold top bar only, no running header."""
        canvas.saveState()
        canvas.setFillColor(GOLD)
        canvas.rect(0, H - 2.5 * mm, W, 2.5 * mm, fill=1, stroke=0)
        canvas.restoreState()

    def on_later_pages(canvas, doc):
        """Content pages — thin header + footer."""
        canvas.saveState()
        canvas.setFont("MSJH", 8)
        canvas.setFillColor(colors.grey)
        canvas.drawString(margin, H - 12 * mm, company)
        canvas.drawRightString(W - margin, H - 12 * mm, report_date)
        canvas.line(margin, H - 13 * mm, W - margin, H - 13 * mm)
        canvas.line(margin, 12 * mm, W - margin, 12 * mm)
        canvas.drawCentredString(W / 2, 8 * mm, f"— {doc.page - 1} —")
        canvas.restoreState()

    doc = SimpleDocTemplate(
        out_path, pagesize=A4,
        leftMargin=margin, rightMargin=margin,
        topMargin=8 * mm, bottomMargin=8 * mm,   # tighter on cover page
        title=company, author="TaiEquityautoresearch",
    )

    styles = make_styles()

    # ── Assemble cover page story ─────────────────────────────────────────────
    story = []
    story.append(hdr_tbl)
    story.append(met_tbl)
    story.append(eps_tbl)
    story.append(Spacer(1, 4 * mm))
    story.append(disc_tbl)
    story.append(PageBreak())

    lines = raw.split("\n")
    i = 0

    while i < len(lines):
        line = lines[i]
        stripped = line.strip()

        # ── Blank line
        if not stripped:
            story.append(Spacer(1, 3))
            i += 1
            continue

        # ── Separator
        if is_separator(line):
            story.append(HRFlowable(width="100%", thickness=0.5,
                                     color=colors.lightgrey, spaceAfter=4))
            i += 1
            continue

        # ── Table
        if is_table_row(line):
            table_lines = []
            while i < len(lines) and is_table_row(lines[i]):
                table_lines.append(lines[i])
                i += 1
            rows = parse_table(table_lines)
            if rows:
                col_count = max(len(r) for r in rows)
                # Pad rows
                rows = [r + [""] * (col_count - len(r)) for r in rows]
                # Convert to Paragraphs
                data = []
                for ri, row in enumerate(rows):
                    p_row = []
                    for cell in row:
                        style = styles["body"] if ri > 0 else ParagraphStyle(
                            "th", fontSize=9, leading=14,
                            fontName=BOLD_FONT,
                            textColor=colors.white)
                        safe = apply_inline(escape_xml(cell), styles)
                        p_row.append(Paragraph(safe, style))
                    data.append(p_row)

                col_width = (W - 2 * margin) / col_count
                t = Table(data, colWidths=[col_width] * col_count,
                          repeatRows=1)
                t.setStyle(TableStyle([
                    ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#0f3460")),
                    ("ROWBACKGROUNDS", (0, 1), (-1, -1),
                     [colors.white, colors.HexColor("#f0f4f8")]),
                    ("GRID", (0, 0), (-1, -1), 0.3, colors.HexColor("#cccccc")),
                    ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                    ("TOPPADDING", (0, 0), (-1, -1), 4),
                    ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
                    ("LEFTPADDING", (0, 0), (-1, -1), 5),
                ]))
                story.append(t)
                story.append(Spacer(1, 6))
            continue

        # ── Blockquote
        if stripped.startswith("> "):
            quote_text = stripped[2:]
            safe = apply_inline(escape_xml(quote_text), styles)
            story.append(Paragraph(f'<para backColor="#f5f5f5" borderPadding="6">{safe}</para>',
                                   styles["quote"]))
            i += 1
            continue

        # ── H1
        if re.match(r'^# ', line):
            text = line[2:].strip()
            safe = escape_xml(text)
            story.append(Spacer(1, 6))
            story.append(Paragraph(safe, styles["h1"]))
            story.append(HRFlowable(width="100%", thickness=1.5,
                                     color=colors.HexColor("#0f3460"), spaceAfter=4))
            i += 1
            continue

        # ── H2
        if re.match(r'^## ', line):
            text = line[3:].strip()
            safe = escape_xml(text)
            story.append(Paragraph(safe, styles["h2"]))
            i += 1
            continue

        # ── H3
        if re.match(r'^### ', line):
            text = line[4:].strip()
            safe = escape_xml(text)
            story.append(Paragraph(safe, styles["h3"]))
            i += 1
            continue

        # ── H4
        if re.match(r'^#### ', line):
            text = line[5:].strip()
            safe = apply_inline(escape_xml(text), styles)
            story.append(Paragraph(f'<b>{safe}</b>', styles["body"]))
            i += 1
            continue

        # ── List item
        if re.match(r'^[\-\*] ', stripped) or re.match(r'^\d+\. ', stripped):
            bullet_text = re.sub(r'^[\-\*\d\.]+\s*', '', stripped)
            safe = apply_inline(escape_xml(bullet_text), styles)
            story.append(Paragraph(f"• {safe}", styles["body"]))
            i += 1
            continue

        # ── Normal paragraph
        safe = apply_inline(escape_xml(stripped), styles)
        story.append(Paragraph(safe, styles["body"]))
        i += 1

    doc.build(story, onFirstPage=on_first_page, onLaterPages=on_later_pages)
    print(f"[OK] PDF generated: {out_path}")
    size_kb = os.path.getsize(out_path) // 1024
    print(f"  Size: {size_kb} KB")


if __name__ == "__main__":
    md = r"C:\Users\機動小隊\TaiEquityautoresearch\data\companies\7738\7738_Initial_MAX.md"
    out = r"C:\Users\機動小隊\TaiEquityautoresearch\data\companies\7738\7738_Report.pdf"
    build_pdf(md, out)
