#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = ["pymupdf>=1.24"]
# ///
"""Convert a Robinhood credit card statement PDF into a QFX (OFX 1.02) file.

Usage:
    uv run robinhood_pdf_to_qfx.py "Credit Statement October 2026.pdf"
    uv run robinhood_pdf_to_qfx.py statement.pdf -o out.qfx --intu-bid 12345

The parsed transactions are reconciled against the statement's own
"Previous Balance" / "New Balance"; the script refuses to write a file
that does not reconcile to the cent.
"""

from __future__ import annotations

import argparse
import hashlib
import re
import sys
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from decimal import Decimal
from pathlib import Path
from xml.sax.saxutils import escape

import pymupdf

MONEY = r"\$?[\d,]+\.\d{2}-?"
TXN_RE = re.compile(
    r"^(?P<tran>\d{2}/\d{2}) (?P<post>\d{2}/\d{2})"
    r"(?: (?P<ref>[A-Z0-9]{17}))?"
    r" (?P<desc>.+?) (?P<amt>[\d,]+\.\d{2}-?)$"
)
# Foreign-currency detail lines, e.g. "- 10/16 CN YUAN RENMINBI" / "- 10/16 1852.71 X 0.14937038"
FX_RE = re.compile(r"^- \d{2}/\d{2} (?P<text>.+)$")
CLOSING_RE = re.compile(r"Statement Closing Date (?P<d>[A-Z][a-z]+ \d{1,2}, \d{4})")
DAYS_RE = re.compile(r"Days in Billing Cycle (?P<n>\d+)")
PREV_RE = re.compile(rf"Previous Balance (?P<v>{MONEY})")
NEW_RE = re.compile(rf"= New Balance (?P<v>{MONEY})")
ACCT_RE = re.compile(r"Account Number: (?:X{4} ){3}(?P<last4>\d{4})")


@dataclass
class Txn:
    tran: date
    post: date
    ref: str | None
    desc: str
    amount: Decimal  # statement sign: positive = charge, negative = credit
    memo: list[str] = field(default_factory=list)

    @property
    def fitid(self) -> str:
        if self.ref:
            return self.ref
        key = f"{self.post.isoformat()}|{self.desc}|{self.amount}"
        return "H" + hashlib.sha1(key.encode()).hexdigest()[:16].upper()

    @property
    def trntype(self) -> str:
        d = self.desc.upper()
        if d.startswith("PAYMENT"):
            return "PAYMENT"
        if "INTEREST" in d:
            return "INT"
        if d.endswith(" FEE"):
            return "FEE"
        return "CREDIT" if self.amount < 0 else "DEBIT"


@dataclass
class Statement:
    last4: str
    closing: date
    days: int
    previous: Decimal
    new: Decimal
    txns: list[Txn]

    @property
    def start(self) -> date:
        return self.closing - timedelta(days=self.days - 1)


def money(s: str) -> Decimal:
    neg = s.endswith("-")
    v = Decimal(s.rstrip("-").lstrip("$").replace(",", ""))
    return -v if neg else v


def page_lines(page: pymupdf.Page) -> list[str]:
    """Rebuild visual lines from word boxes (the PDF's own text order is columnar)."""
    words = sorted(page.get_text("words"), key=lambda w: (w[3], w[0]))
    lines: list[list[tuple]] = []
    for w in words:
        if lines and abs(lines[-1][0][3] - w[3]) < 3:
            lines[-1].append(w)
        else:
            lines.append([w])
    return [" ".join(w[4] for w in sorted(ln, key=lambda w: w[0])) for ln in lines]


def resolve(mmdd: str, closing: date) -> date:
    m, d = map(int, mmdd.split("/"))
    year = closing.year - 1 if m > closing.month else closing.year
    return date(year, m, d)


def parse(pdf: Path) -> Statement:
    with pymupdf.open(pdf) as doc:
        lines = [ln for page in doc for ln in page_lines(page)]
    text = "\n".join(lines)

    def need(rx: re.Pattern, what: str) -> re.Match:
        m = rx.search(text)
        if not m:
            sys.exit(f"error: could not find {what} in {pdf}")
        return m

    closing = datetime.strptime(need(CLOSING_RE, "statement closing date")["d"], "%B %d, %Y").date()
    stmt = Statement(
        last4=need(ACCT_RE, "account number")["last4"],
        closing=closing,
        days=int(need(DAYS_RE, "days in billing cycle")["n"]),
        previous=money(need(PREV_RE, "previous balance")["v"]),
        new=money(need(NEW_RE, "new balance")["v"]),
        txns=[],
    )

    in_txns = False
    for ln in lines:
        if ln.startswith("TRANSACTIONS"):
            in_txns = True
            continue
        if not in_txns:
            continue
        if ln.startswith(("Totals ", "INTEREST CHARGE CALCULATION")):
            break
        if m := TXN_RE.match(ln):
            amount = money(m["amt"])
            if not m["ref"] and amount == 0:
                continue  # zero interest-charge lines
            stmt.txns.append(
                Txn(
                    tran=resolve(m["tran"], closing),
                    post=resolve(m["post"], closing),
                    ref=m["ref"],
                    desc=m["desc"],
                    amount=amount,
                )
            )
        elif (m := FX_RE.match(ln)) and stmt.txns:
            stmt.txns[-1].memo.append(m["text"])
    return stmt


def reconcile(stmt: Statement) -> None:
    total = sum((t.amount for t in stmt.txns), Decimal(0))
    expected = stmt.new - stmt.previous
    if total != expected:
        sys.exit(
            f"error: parsed {len(stmt.txns)} transactions totalling {total}, but statement says "
            f"{stmt.previous} -> {stmt.new} ({expected}). Refusing to write an unbalanced file."
        )


def ofx_date(d: date) -> str:
    return d.strftime("%Y%m%d120000")


def to_qfx(stmt: Statement, org: str, fid: str, intu_bid: str | None) -> str:
    now = datetime.now().strftime("%Y%m%d%H%M%S")
    out = [
        "OFXHEADER:100",
        "DATA:OFXSGML",
        "VERSION:102",
        "SECURITY:NONE",
        "ENCODING:USASCII",
        "CHARSET:1252",
        "COMPRESSION:NONE",
        "OLDFILEUID:NONE",
        "NEWFILEUID:NONE",
        "",
        "<OFX>",
        "<SIGNONMSGSRSV1><SONRS>",
        "<STATUS><CODE>0<SEVERITY>INFO</STATUS>",
        f"<DTSERVER>{now}",
        "<LANGUAGE>ENG",
        f"<FI><ORG>{escape(org)}<FID>{escape(fid)}</FI>",
    ]
    if intu_bid:
        out.append(f"<INTU.BID>{escape(intu_bid)}")
    out += [
        "</SONRS></SIGNONMSGSRSV1>",
        "<CREDITCARDMSGSRSV1><CCSTMTTRNRS>",
        "<TRNUID>0",
        "<STATUS><CODE>0<SEVERITY>INFO</STATUS>",
        "<CCSTMTRS>",
        "<CURDEF>USD",
        f"<CCACCTFROM><ACCTID>{stmt.last4}</CCACCTFROM>",
        "<BANKTRANLIST>",
        f"<DTSTART>{ofx_date(stmt.start)}",
        f"<DTEND>{ofx_date(stmt.closing)}",
    ]
    for t in stmt.txns:
        # OFX credit-card convention: charges negative, payments/credits positive.
        amt = -t.amount
        name = t.desc[:32]
        memo = " ".join([t.desc] + t.memo) if (t.memo or len(t.desc) > 32) else None
        out += [
            "<STMTTRN>",
            f"<TRNTYPE>{t.trntype}",
            f"<DTPOSTED>{ofx_date(t.post)}",
            f"<DTUSER>{ofx_date(t.tran)}",
            f"<TRNAMT>{amt:.2f}",
            f"<FITID>{t.fitid}",
            f"<NAME>{escape(name)}",
        ]
        if memo:
            out.append(f"<MEMO>{escape(memo[:255])}")
        out.append("</STMTTRN>")
    out += [
        "</BANKTRANLIST>",
        f"<LEDGERBAL><BALAMT>{-stmt.new:.2f}<DTASOF>{ofx_date(stmt.closing)}</LEDGERBAL>",
        "</CCSTMTRS>",
        "</CCSTMTTRNRS></CREDITCARDMSGSRSV1>",
        "</OFX>",
        "",
    ]
    return "\r\n".join(out)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("pdf", type=Path, help="Robinhood credit statement PDF")
    ap.add_argument("-o", "--output", type=Path, help="output .qfx (default: next to the PDF)")
    ap.add_argument("--org", default="Robinhood Credit", help="<ORG> value (default: %(default)s)")
    ap.add_argument("--fid", default="0000", help="<FID> value (default: %(default)s)")
    ap.add_argument("--intu-bid", help="Quicken bank ID (<INTU.BID>); omit for plain OFX importers")
    args = ap.parse_args()

    stmt = parse(args.pdf)
    reconcile(stmt)
    out = args.output or args.pdf.with_suffix(".qfx")
    out.write_text(to_qfx(stmt, args.org, args.fid, args.intu_bid), encoding="ascii", errors="replace")
    charges = sum((t.amount for t in stmt.txns if t.amount > 0), Decimal(0))
    credits = sum((t.amount for t in stmt.txns if t.amount < 0), Decimal(0))
    print(
        f"{out}: {len(stmt.txns)} transactions {stmt.start}..{stmt.closing}, "
        f"charges {charges}, credits {credits}, balance {stmt.previous} -> {stmt.new} (reconciled)"
    )


if __name__ == "__main__":
    main()
