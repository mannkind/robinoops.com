import './style.css';
import { extractStatement } from './pdf.ts';
import { reconcile, toQfx } from './converter.ts';
import type { Statement } from './converter.ts';

function byId(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (!(element instanceof HTMLElement)) throw new Error(`Missing HTML element: ${id}`);
  return element;
}

function inputById(id: string): HTMLInputElement {
  const element = byId(id);
  if (!(element instanceof HTMLInputElement)) throw new Error(`Expected an input element: ${id}`);
  return element;
}

function buttonById(id: string): HTMLButtonElement {
  const element = byId(id);
  if (!(element instanceof HTMLButtonElement)) throw new Error(`Expected a button element: ${id}`);
  return element;
}

const input = inputById('pdf-input');
const dropZone = byId('drop-zone');
const outputPanel = byId('output-panel');
const results = byId('results');
const emptyState = byId('empty-state');
const downloadButton = buttonById('download-button');
const status = byId('status');
const errorBox = byId('error');
const rows = byId('transaction-rows');
const currency = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const dateFormat = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
let generation = 0;
let statement: Statement | null = null;
let originalName = '';
let downloadUrl: string | null = null;
let downloadTimer: number | null = null;
let dragDepth = 0;

const money = (cents: number): string => currency.format(cents / 100);
const signedMoney = (cents: number): string => `${cents < 0 ? '−' : '+'}${money(Math.abs(cents))}`;
const date = (iso: string): string => dateFormat.format(new Date(`${iso}T00:00:00Z`));

function releaseDownload(): void {
  if (downloadTimer !== null) window.clearTimeout(downloadTimer);
  if (downloadUrl !== null) URL.revokeObjectURL(downloadUrl);
  downloadUrl = null;
  downloadTimer = null;
}

function invalidate(): number {
  generation += 1;
  statement = null;
  originalName = '';
  releaseDownload();
  input.value = '';
  downloadButton.disabled = true;
  results.hidden = true;
  emptyState.hidden = false;
  rows.replaceChildren();
  for (const id of ['account-last4', 'statement-range', 'previous-balance', 'new-balance', 'charges', 'credits', 'reconciliation-proof', 'transaction-count', 'file-name']) {
    byId(id).textContent = '';
  }
  byId('file-selection').hidden = true;
  byId('export-note').textContent = 'A reconciled statement unlocks your download.';
  outputPanel.setAttribute('aria-busy', 'false');
  dropZone.classList.remove('is-processing', 'is-dragging');
  dragDepth = 0;
  status.classList.remove('is-processing');
  errorBox.textContent = '';
  errorBox.hidden = true;
  return generation;
}

function showError(message: string): void {
  errorBox.textContent = message;
  errorBox.hidden = false;
  status.textContent = 'No export created. Choose a supported statement to try again.';
}

function renderStatement(value: Statement): void {
  const totals = reconcile(value);
  byId('account-last4').textContent = value.last4;
  byId('statement-range').textContent = `${date(value.start)} – ${date(value.closing)}`;
  byId('previous-balance').textContent = money(value.previous);
  byId('new-balance').textContent = money(value.new);
  byId('charges').textContent = signedMoney(totals.charges);
  byId('credits').textContent = signedMoney(totals.credits);
  byId('transaction-count').textContent = String(value.txns.length);
  byId('reconciliation-proof').textContent = `${money(value.previous)} + ${money(totals.charges)} − ${money(Math.abs(totals.credits))} = ${money(value.new)}`;

  const fragment = document.createDocumentFragment();
  for (const txn of value.txns) {
    const row = document.createElement('tr');
    const dateCell = document.createElement('td');
    dateCell.className = 'date-cell';
    const transactionDate = document.createElement('time');
    transactionDate.dateTime = txn.tran;
    transactionDate.textContent = date(txn.tran);
    dateCell.append(transactionDate);
    const posting = document.createElement('span');
    posting.className = 'posted-date';
    posting.textContent = `Posted ${date(txn.post)}`;
    dateCell.append(posting);

    const descriptionCell = document.createElement('td');
    descriptionCell.className = 'description-cell';
    const description = document.createElement('span');
    description.textContent = txn.desc;
    descriptionCell.append(description);
    if (txn.memo.length) {
      const details = document.createElement('details');
      details.className = 'fx-details';
      const summary = document.createElement('summary');
      summary.textContent = 'Foreign currency details';
      const memo = document.createElement('ul');
      for (const line of txn.memo) {
        const item = document.createElement('li');
        item.textContent = line;
        memo.append(item);
      }
      details.append(summary, memo);
      descriptionCell.append(details);
    }
    const amountCell = document.createElement('td');
    amountCell.className = txn.amount < 0 ? 'amount-cell credit-amount' : 'amount-cell';
    amountCell.textContent = signedMoney(txn.amount);
    row.append(dateCell, descriptionCell, amountCell);
    fragment.append(row);
  }
  rows.replaceChildren(fragment);
  results.hidden = false;
  emptyState.hidden = true;
}

async function selectFiles(files: readonly File[]): Promise<void> {
  const current = invalidate();
  const file = files[0];
  if (files.length !== 1 || file === undefined) {
    showError('Choose exactly one PDF at a time. Your previous selection has been cleared.');
    return;
  }
  byId('file-name').textContent = file.name;
  byId('file-selection').hidden = false;
  if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') {
    showError('This is not a PDF. Choose a Robinhood credit card statement PDF, not a CSV or brokerage statement.');
    return;
  }
  outputPanel.setAttribute('aria-busy', 'true');
  dropZone.classList.add('is-processing');
  status.classList.add('is-processing');
  status.textContent = 'Reading your PDF and checking every cent…';
  byId('export-note').textContent = 'Processing locally. No file is being uploaded.';
  try {
    const bytes = await file.arrayBuffer();
    if (current !== generation) return;
    const parsed = await extractStatement(bytes);
    if (current !== generation) return;
    renderStatement(parsed);
    statement = parsed;
    originalName = file.name;
    downloadButton.disabled = false;
    status.textContent = `Ready: ${parsed.txns.length} transaction${parsed.txns.length === 1 ? '' : 's'}, reconciled to the cent.`;
    byId('export-note').textContent = 'Checked against your statement. Ready for your finance app.';
  } catch (error) {
    if (current !== generation) return;
    // A failed selection must never leave a previous statement available to export.
    invalidate();
    byId('file-name').textContent = file.name;
    byId('file-selection').hidden = false;
    showError(error instanceof Error ? error.message : 'The statement could not be read. Choose a supported Robinhood credit card PDF.');
  } finally {
    if (current === generation) {
      outputPanel.setAttribute('aria-busy', 'false');
      dropZone.classList.remove('is-processing');
      status.classList.remove('is-processing');
    }
  }
}

input.addEventListener('change', () => {
  // Copy the FileList before resetting the input, including for same-file retries.
  const files = Array.from(input.files ?? []);
  if (files.length) void selectFiles(files);
});

for (const eventName of ['dragenter', 'dragover', 'dragleave', 'drop']) {
  dropZone.addEventListener(eventName, (event) => event.preventDefault());
}
dropZone.addEventListener('dragenter', () => {
  dragDepth += 1;
  dropZone.classList.add('is-dragging');
});
dropZone.addEventListener('dragover', (event) => {
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
});
dropZone.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) dropZone.classList.remove('is-dragging');
});
dropZone.addEventListener('drop', (event) => {
  void selectFiles(Array.from(event.dataTransfer?.files ?? []));
});
// Prevent an accidental drop outside the target from navigating away to the PDF.
window.addEventListener('dragover', (event) => {
  if (Array.from(event.dataTransfer?.types ?? []).includes('Files')) event.preventDefault();
});
window.addEventListener('drop', (event) => {
  if (Array.from(event.dataTransfer?.types ?? []).includes('Files')) event.preventDefault();
});

byId('reset-button').addEventListener('click', () => {
  invalidate();
  status.textContent = 'Statement cleared. Choose another PDF when you’re ready.';
  input.focus();
});

downloadButton.addEventListener('click', () => {
  if (!statement || downloadButton.disabled) return;
  try {
    const qfx = toQfx(statement, {
      org: inputById('org').value,
      fid: inputById('fid').value,
      intuBid: inputById('intu-bid').value,
    });
    releaseDownload();
    downloadUrl = URL.createObjectURL(new Blob([qfx], { type: 'application/vnd.intu.qfx' }));
    const link = document.createElement('a');
    link.href = downloadUrl;
    link.download = `${originalName.replace(/\.pdf$/i, '')}.qfx`;
    document.body.append(link);
    link.click();
    link.remove();
    downloadTimer = window.setTimeout(releaseDownload, 1000);
    status.textContent = 'QFX download requested. Your statement stays here until you clear it or close this page.';
  } catch (error) {
    invalidate();
    showError(error instanceof Error ? error.message : 'The QFX file could not be created. Choose your statement again.');
  }
});

window.addEventListener('pagehide', () => {
  invalidate();
  status.textContent = 'Ready when your statement is.';
});
