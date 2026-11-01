import { sha1 } from '@noble/hashes/legacy.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';

export interface Transaction {
  tran: string;
  post: string;
  ref: string | null;
  desc: string;
  amount: number;
  memo: string[];
}

export interface Statement {
  last4: string;
  closing: string;
  start: string;
  days: number;
  previous: number;
  new: number;
  txns: Transaction[];
}

export interface Reconciliation {
  total: number;
  expected: number;
  charges: number;
  credits: number;
}

export interface QfxOptions {
  org?: string;
  fid?: string;
  intuBid?: string;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const MONEY = String.raw`\$?(?:\d+|\d{1,3}(?:,\d{3})+)\.\d{2}-?`;
const TXN = /^(\d{2}\/\d{2}) (\d{2}\/\d{2})(?: ([A-Z0-9]{17}))? (.+?) ((?:\d+|\d{1,3}(?:,\d{3})+)\.\d{2}-?)$/;
const DAY = 86400000;

function dateValue(value: string, label: string): Date {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`Invalid ${label}.`);
  const date = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value || value.startsWith('0000')) {
    throw new Error(`Invalid calendar date for ${label}: ${value}.`);
  }
  return date;
}

function isoDate(year: number, month: number, day: number, label: string): string {
  const value = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  dateValue(value, label);
  return value;
}

function cycleStart(closing: string, days: number): string {
  const date = dateValue(closing, 'statement closing date');
  if (!Number.isSafeInteger(days) || days < 1) throw new Error('Invalid days in billing cycle.');
  const start = new Date(date.getTime() - (days - 1) * DAY);
  if (!Number.isFinite(start.getTime())) throw new Error('Invalid billing cycle start date.');
  const value = start.toISOString().slice(0, 10);
  dateValue(value, 'billing cycle start date');
  return value;
}

function cents(value: string): number {
  const clean = value.replace(/[$,]/g, '').replace(/-$/, '');
  const [whole, fraction] = clean.split('.');
  const amount = Number(whole) * 100 + Number(fraction);
  if (!Number.isSafeInteger(amount)) throw new Error('Statement amount exceeds the supported exact range.');
  return value.endsWith('-') && amount !== 0 ? -amount : amount;
}

function money(value: number): string {
  return `${value < 0 ? '-' : ''}${Math.floor(Math.abs(value) / 100)}.${String(Math.abs(value) % 100).padStart(2, '0')}`;
}

function resolve(mmdd: string, closing: string): string {
  const [month, day] = mmdd.split('/').map(Number);
  if (month === undefined || day === undefined) throw new Error('Invalid transaction date.');
  const year = Number(closing.slice(0, 4)) - (month > Number(closing.slice(5, 7)) ? 1 : 0);
  return isoDate(year, month, day, 'transaction');
}

function capture(match: RegExpMatchArray, index: number): string {
  const value = match[index];
  if (value === undefined) throw new Error('Statement text is unreadable.');
  return value;
}

function validateLines(lines: unknown): void {
  if (!Array.isArray(lines) || lines.some((line: unknown) => typeof line !== 'string')) throw new Error('Statement text is unreadable.');
}

export function parseLines(lines: readonly string[]): Statement {
  validateLines(lines);
  const text = lines.join('\n');
  function need(pattern: RegExp, label: string): RegExpMatchArray {
    const match = text.match(pattern);
    if (!match) throw new Error(`Could not find ${label}. Use a Robinhood credit card statement PDF with selectable text.`);
    return match;
  }
  const closingMatch = need(/Statement Closing Date ([A-Z][a-z]+) (\d{1,2}), (\d{4})\b/, 'statement closing date');
  const closing = isoDate(Number(capture(closingMatch, 3)), MONTHS.indexOf(capture(closingMatch, 1)) + 1, Number(capture(closingMatch, 2)), 'statement closing date');
  const days = Number(capture(need(/Days in Billing Cycle (\d+)\b/, 'days in billing cycle'), 1));
  const statement: Statement = {
    last4: capture(need(/Account Number: (?:X{4} ){3}(\d{4})\b/, 'account number'), 1),
    closing,
    start: cycleStart(closing, days),
    days,
    previous: cents(capture(need(new RegExp(`Previous Balance (${MONEY})(?=\\s|$)`), 'previous balance'), 1)),
    new: cents(capture(need(new RegExp(`= New Balance (${MONEY})(?=\\s|$)`), 'new balance'), 1)),
    txns: [],
  };
  let inTransactions = false;
  let sawTransactions = false;
  for (const line of lines) {
    if (line.startsWith('TRANSACTIONS')) {
      inTransactions = true;
      sawTransactions = true;
      continue;
    }
    if (!inTransactions) continue;
    if (line.startsWith('Totals ') || line.startsWith('INTEREST CHARGE CALCULATION')) break;
    const match = line.match(TXN);
    if (match) {
      const amount = cents(capture(match, 5));
      const tran = resolve(capture(match, 1), closing);
      const post = resolve(capture(match, 2), closing);
      if (!match[3] && amount === 0) continue;
      statement.txns.push({ tran, post, ref: match[3] ?? null, desc: capture(match, 4), amount, memo: [] });
    } else {
      const fx = line.match(/^- \d{2}\/\d{2} (.+)$/);
      const previous = statement.txns.at(-1);
      if (fx && previous) previous.memo.push(capture(fx, 1));
      else if (/^\d{1,2}\/\d{1,2}\b/.test(line)) throw new Error(`Could not parse transaction: ${line}`);
    }
  }
  if (!sawTransactions) throw new Error('Could not find the statement transactions section.');
  return statement;
}

function exact(value: number, label: string): number {
  if (!Number.isSafeInteger(value)) throw new Error(`Invalid or out-of-range ${label}; amounts must be exact integer cents.`);
  return value;
}

export function reconcile(statement: Statement): Reconciliation {
  if (!statement || !/^\d{4}$/.test(statement.last4) || typeof statement.last4 !== 'string') throw new Error('Invalid account number.');
  if (statement.start !== cycleStart(statement.closing, statement.days)) throw new Error('Invalid billing cycle start date.');
  exact(statement.previous, 'previous balance');
  exact(statement.new, 'new balance');
  if (!Array.isArray(statement.txns)) throw new Error('Invalid transaction list.');
  let total = 0;
  let charges = 0;
  let credits = 0;
  for (const txn of statement.txns) {
    if (!txn || typeof txn.desc !== 'string' || !txn.desc.trim() || !Array.isArray(txn.memo) || txn.memo.some(value => typeof value !== 'string')) throw new Error('Invalid transaction description or memo.');
    if (txn.ref != null && (typeof txn.ref !== 'string' || !/^[A-Z0-9]{17}$/.test(txn.ref))) throw new Error('Invalid transaction reference.');
    dateValue(txn.tran, 'transaction date');
    dateValue(txn.post, 'posting date');
    exact(txn.amount, 'transaction amount');
    total = exact(total + txn.amount, 'transaction total');
    if (txn.amount > 0) charges = exact(charges + txn.amount, 'charges');
    if (txn.amount < 0) credits = exact(credits + txn.amount, 'credits');
  }
  const expected = exact(statement.new - statement.previous, 'balance change');
  if (total !== expected) throw new Error(`Parsed ${statement.txns.length} transactions totaling ${money(total)}, but the statement balances require ${money(expected)} (${money(statement.previous)} → ${money(statement.new)}). Refusing to export an unbalanced file.`);
  return { total, expected, charges, credits };
}

function escape(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function ofxDate(value: string): string {
  return `${value.replaceAll('-', '')}120000`;
}

function serverTime(): string {
  const now = new Date();
  return [now.getFullYear(), now.getMonth() + 1, now.getDate(), now.getHours(), now.getMinutes(), now.getSeconds()]
    .map((part, index) => String(part).padStart(index === 0 ? 4 : 2, '0')).join('');
}

function fitid(txn: Transaction): string {
  return txn.ref || `H${bytesToHex(sha1(utf8ToBytes(`${txn.post}|${txn.desc}|${money(txn.amount)}`))).slice(0, 16).toUpperCase()}`;
}

function transactionType(txn: Transaction): string {
  const description = txn.desc.toUpperCase();
  if (description.startsWith('PAYMENT')) return 'PAYMENT';
  if (description.includes('INTEREST')) return 'INT';
  if (description.endsWith(' FEE')) return 'FEE';
  return txn.amount < 0 ? 'CREDIT' : 'DEBIT';
}

function invalidMetadata(value: string): boolean {
  if (typeof value !== 'string') return true;
  for (const character of value) {
    const code = character.charCodeAt(0);
    if ((code < 32 && code !== 9) || code === 127) return true;
  }
  return false;
}

export function toQfx(statement: Statement, { org = 'Robinhood Credit', fid = '0000', intuBid = '' }: QfxOptions = {}): string {
  reconcile(statement);
  if ([org, fid, intuBid].some(invalidMetadata)) throw new Error('Invalid financial institution metadata.');
  const out = [
    'OFXHEADER:100', 'DATA:OFXSGML', 'VERSION:102', 'SECURITY:NONE',
    'ENCODING:USASCII', 'CHARSET:1252', 'COMPRESSION:NONE', 'OLDFILEUID:NONE', 'NEWFILEUID:NONE', '',
    '<OFX>', '<SIGNONMSGSRSV1><SONRS>', '<STATUS><CODE>0<SEVERITY>INFO</STATUS>',
    `<DTSERVER>${serverTime()}`, '<LANGUAGE>ENG', `<FI><ORG>${escape(org)}<FID>${escape(fid)}</FI>`,
  ];
  if (intuBid) out.push(`<INTU.BID>${escape(intuBid)}`);
  out.push('</SONRS></SIGNONMSGSRSV1>', '<CREDITCARDMSGSRSV1><CCSTMTTRNRS>', '<TRNUID>0',
    '<STATUS><CODE>0<SEVERITY>INFO</STATUS>', '<CCSTMTRS>', '<CURDEF>USD',
    `<CCACCTFROM><ACCTID>${statement.last4}</CCACCTFROM>`, '<BANKTRANLIST>',
    `<DTSTART>${ofxDate(statement.start)}`, `<DTEND>${ofxDate(statement.closing)}`);
  for (const txn of statement.txns) {
    const characters = Array.from(txn.desc);
    const memo = txn.memo.length || characters.length > 32 ? [txn.desc, ...txn.memo].join(' ') : null;
    out.push('<STMTTRN>', `<TRNTYPE>${transactionType(txn)}`, `<DTPOSTED>${ofxDate(txn.post)}`,
      `<DTUSER>${ofxDate(txn.tran)}`, `<TRNAMT>${money(-txn.amount)}`, `<FITID>${fitid(txn)}`,
      `<NAME>${escape(characters.slice(0, 32).join(''))}`);
    if (memo) out.push(`<MEMO>${escape(Array.from(memo).slice(0, 255).join(''))}`);
    out.push('</STMTTRN>');
  }
  out.push('</BANKTRANLIST>', `<LEDGERBAL><BALAMT>${money(-statement.new)}<DTASOF>${ofxDate(statement.closing)}</LEDGERBAL>`,
    '</CCSTMTRS>', '</CCSTMTTRNRS></CREDITCARDMSGSRSV1>', '</OFX>', '');
  // Python writes ASCII with errors='replace': one question mark per Unicode code point.
  return out.join('\r\n').replace(/[^\p{ASCII}]/gu, '?');
}
