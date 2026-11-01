import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { parseLines, reconcile, toQfx } from '../src/converter.ts';
import type { Statement } from '../src/converter.ts';

interface StatementOptions {
  closing?: string;
  days?: number;
  previous?: string;
  balance?: string;
}

function statementLines(transactions: readonly string[] = [], { closing = 'January 15, 2026', days = 31, previous = '0.00', balance = '0.00' }: StatementOptions = {}): string[] {
  return [
    'Account Number: XXXX XXXX XXXX 1234',
    `Statement Closing Date ${closing}`,
    `Days in Billing Cycle ${days}`,
    `Previous Balance $${previous}`,
    `= New Balance $${balance}`,
    'TRANSACTIONS',
    'Transaction Date Posting Date Reference Number Description Amount',
    ...transactions,
    'Totals for this period',
  ];
}

function statement(transactions: readonly string[] = [], options?: StatementOptions): Statement {
  return parseLines(statementLines(transactions, options));
}

function expectedId(post: string, description: string, decimal: string): string {
  // Same UTF-8 key and digest convention as Python hashlib.sha1, independently
  // calculated with Node crypto rather than the browser implementation.
  return `H${createHash('sha1').update(`${post}|${description}|${decimal}`, 'utf8').digest('hex').slice(0, 16).toUpperCase()}`;
}

await test('integer cents reconcile exactly and a one-cent discrepancy refuses export', () => {
  const value = statement(['01/02 01/03 SHOP A 0.10', '01/02 01/03 SHOP B 0.20'], { balance: '0.30' });
  assert.deepEqual(reconcile(value), { total: 30, expected: 30, charges: 30, credits: 0 });
  value.new = 31;
  assert.throws(() => reconcile(value));
  assert.throws(() => toQfx(value));
});

await test('New Year dates resolve independently and the cycle includes both endpoints', () => {
  const value = statement(['12/31 01/02 YEAR END SHOP 10.00'], { balance: '10.00' });
  assert.equal(value.start, '2025-12-16');
  const txn = value.txns[0];
  assert.ok(txn);
  assert.equal(txn.tran, '2025-12-31');
  assert.equal(txn.post, '2026-01-02');
  const qfx = toQfx(value);
  assert.match(qfx, /<DTUSER>20251231120000/);
  assert.match(qfx, /<DTPOSTED>20260102120000/);
});

await test('reference IDs and foreign-currency memos are preserved', () => {
  const reference = '1234567890ABCDEFG';
  const value = statement([
    `01/02 01/03 ${reference} OVERSEAS SHOP 276.74`,
    '- 01/02 CN YUAN RENMINBI',
    '- 01/02 1852.71 X 0.14937038',
  ], { balance: '276.74' });
  const txn = value.txns[0];
  assert.ok(txn);
  assert.equal(txn.ref, reference);
  assert.deepEqual(txn.memo, ['CN YUAN RENMINBI', '1852.71 X 0.14937038']);
  const qfx = toQfx(value);
  assert.ok(qfx.includes(`<FITID>${reference}\r\n`));
  assert.ok(qfx.includes('<MEMO>OVERSEAS SHOP CN YUAN RENMINBI 1852.71 X 0.14937038\r\n'));
});

await test('fallback IDs hash original Unicode and signed two-decimal amounts', () => {
  const value = statement(['01/02 01/03 CAFÉ 🍵 10.20', '01/04 01/05 REFUND 1.00-'], { balance: '9.20' });
  const qfx = toQfx(value);
  assert.ok(qfx.includes(`<FITID>${expectedId('2026-01-03', 'CAFÉ 🍵', '10.20')}\r\n`));
  assert.ok(qfx.includes(`<FITID>${expectedId('2026-01-05', 'REFUND', '-1.00')}\r\n`));
  assert.ok(qfx.includes('<NAME>CAF? ?\r\n'));
});

await test('statement signs reverse for QFX and transaction types follow Python precedence', () => {
  const value = statement([
    '01/01 01/02 SHOP 1,234.56',
    '01/02 01/03 PAYMENT THANK YOU 1,000.00-',
    '01/03 01/04 REFUND 10.00-',
    '01/04 01/05 PURCHASE INTEREST 1.23',
    '01/05 01/06 LATE FEE 2.00',
  ], { previous: '50.00', balance: '277.79' });
  assert.deepEqual(reconcile(value), { total: 22779, expected: 22779, charges: 123779, credits: -101000 });
  const qfx = toQfx(value);
  assert.deepEqual([...qfx.matchAll(/<TRNTYPE>(\w+)/g)].map(match => {
    const type = match[1];
    assert.ok(type);
    return type;
  }), ['DEBIT', 'PAYMENT', 'CREDIT', 'INT', 'FEE']);
  assert.deepEqual([...qfx.matchAll(/<TRNAMT>([^\r]+)/g)].map(match => {
    const amount = match[1];
    assert.ok(amount);
    return amount;
  }), ['-1234.56', '1000.00', '10.00', '-1.23', '-2.00']);
  assert.ok(qfx.includes('<LEDGERBAL><BALAMT>-277.79'));
});

await test('negative balances and zero transactions are valid when balanced', () => {
  const value = statement([], { previous: '10.00-', balance: '10.00-' });
  assert.deepEqual(reconcile(value), { total: 0, expected: 0, charges: 0, credits: 0 });
  const qfx = toQfx(value);
  assert.ok(!qfx.includes('<STMTTRN>'));
  assert.ok(qfx.includes('<LEDGERBAL><BALAMT>10.00'));
});

await test('unreferenced zero interest is omitted but referenced zero transactions remain', () => {
  const value = statement(['01/01 01/02 PURCHASE INTEREST 0.00', '01/01 01/02 1234567890ABCDEFG SHOP 0.00']);
  assert.equal(value.txns.length, 1);
  const txn = value.txns[0];
  assert.ok(txn);
  assert.equal(txn.desc, 'SHOP');
  assert.ok(toQfx(value).includes('<TRNAMT>0.00\r\n'));
});

await test('QFX escapes SGML, uses CRLF, and truncates by code point before ASCII conversion', () => {
  const desc = `${'🍵'.repeat(31)}&<TAIL>`;
  const value = statement([`01/01 01/02 ${desc} 1.00`], { balance: '1.00' });
  const txn = value.txns[0];
  assert.ok(txn);
  txn.memo.push('é'.repeat(300));
  const qfx = toQfx(value, { org: 'Bank & <Org>', fid: 'A&B', intuBid: '<123>' });
  assert.ok(qfx.includes('<ORG>Bank &amp; &lt;Org&gt;<FID>A&amp;B'));
  assert.ok(qfx.includes('<INTU.BID>&lt;123&gt;'));
  assert.ok(qfx.includes(`<NAME>${'?'.repeat(31)}&amp;\r\n`));
  const firstMemo = txn.memo[0];
  assert.ok(firstMemo);
  const memo = `${desc} ${firstMemo}`;
  const expected = Array.from(memo).slice(0, 255).join('').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replace(/[^\p{ASCII}]/gu, '?');
  assert.ok(qfx.includes(`<MEMO>${expected}\r\n`));
  assert.ok(!/[^\p{ASCII}]/u.test(qfx));
  assert.ok(!/(?<!\r)\n/.test(qfx));
  assert.ok(qfx.endsWith('</OFX>\r\n'));
});

await test('invalid calendar dates, missing fields, and malformed transaction rows are blocked', () => {
  assert.throws(() => statement([], { closing: 'February 30, 2026' }));
  assert.throws(() => statement(['02/29 03/01 SHOP 1.00'], { closing: 'March 15, 2026', balance: '1.00' }));
  const leap = statement(['02/29 03/01 SHOP 1.00'], { closing: 'March 15, 2024', balance: '1.00' });
  const txn = leap.txns[0];
  assert.ok(txn);
  assert.equal(txn.tran, '2024-02-29');
  assert.equal(txn.post, '2024-03-01');
  assert.throws(() => statement([], { days: 0 }));
  assert.throws(() => parseLines(statementLines().filter(line => !line.startsWith('Account Number'))));
  assert.throws(() => parseLines(statementLines().filter(line => line !== 'TRANSACTIONS')));
  assert.throws(() => statement(['01/01 01/02 SHOP 1.0']));
  assert.throws(() => statement(['01/01 01/02 SHOP 1,23.00']));
});

await test('mutated invalid financial data cannot bypass export validation', () => {
  const value = statement(['01/01 01/02 SHOP 1.00'], { balance: '1.00' });
  const txn = value.txns[0];
  assert.ok(txn);
  txn.amount = 99.999;
  assert.throws(() => toQfx(value));
  txn.amount = 100;
  txn.post = '2026-02-30';
  assert.throws(() => toQfx(value));
  txn.post = '2026-01-02';
  value.start = '2025-12-17';
  assert.throws(() => toQfx(value));
});
