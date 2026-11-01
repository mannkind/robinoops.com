# RobinOops

Robinhood's CSV export combines transactions, includes declined transactions, and leaves others out. Their statement PDFs contain the actual data, so this converts those to QFX instead.

Everything runs in your browser. Nothing gets uploaded. If the transactions don't reconcile to the statement balance, it won't export.

They had one job.

## Run it

Use Node 24.12.0 (`.node-version`).

```sh
npm ci
npm run build
npm run preview
```

Open the local URL, choose a Robinhood **credit card** statement PDF, review the transactions, and download the QFX. Brokerage statements, scans, and password-protected PDFs aren't supported.

For development, use `npm run dev`. The original Python converter is included too.

## Checks

```sh
npm run check  # strict TypeScript and ESLint
npm test       # conversion tests
```

Builds require the type and lint checks to pass. Lefthook runs those before commits, and builds plus tests before pushes.

With Lefthook installed, run `lefthook install`. If your global Git hooks forward to `.git/hooks`, install there instead:

```sh
env GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=.git/hooks lefthook install --force
```

## Deploy

Serve `dist/` on any static HTTP(S) host. No backend, CDN, or runtime dependencies. Opening `index.html` directly with `file://` won't work.

For **Cloudflare Pages**, connect the repository with these settings:

| Setting | Value |
| --- | --- |
| Project | `robinoops-com` |
| Production branch | `main` |
| Framework | None |
| Root | Repository root |
| Build command | `npm run build` |
| Output | `dist` |

Add `robinoops.com` under **Custom domains** after deployment. Use Pages, not Workers; this project doesn't use `wrangler deploy` or a Worker entry point.

## Limits

- Check the preview. Reconciliation catches balance mismatches, not every possible parsing error. Real-statement compatibility and Quicken import haven't been verified.
- Quicken may need the correct institution identifiers in the advanced settings. The default FID `0000` isn't a verified bank ID.
- QFX output matches the Python converter: non-ASCII characters become `?`, long names and memos are truncated, and unreferenced zero-amount rows are skipped. Identical transactions without reference numbers can share an ID.

Not affiliated with Robinhood.
