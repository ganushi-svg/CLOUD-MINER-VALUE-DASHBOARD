---
name: ingest-pricelist
description: Parse a supplier miner price list (pasted text) into price observations, show what resolved and what did not, and optionally ingest it into the deployed price feed. Use when someone pastes a WhatsApp/supplier price list or asks what a list would do to the valuation.
argument-hint: [paste the price list, or a path to a text file]
arguments: [list]
allowed-tools: Bash(node *) Bash(curl *)
---

Price list to process:

```
$list
```

## Steps

1. **Dry run locally, never guess.** Write the list to `${CLAUDE_PROJECT_DIR}/.scratch/pricelist.txt`
   (create the directory; it is git-ignored) and run:

   ```bash
   cd ${CLAUDE_PROJECT_DIR} && INGEST_SOURCES=fixture node --input-type=module -e "
   import { readFileSync } from 'node:fs';
   import { buildDataset } from './src/dataset.js';
   import { buildResolver, parsePriceList } from './src/pricefeed/parse.js';
   const d = await buildDataset();
   const r = parsePriceList(readFileSync('.scratch/pricelist.txt','utf8'), { source: 'dry-run' }, buildResolver(d.models));
   console.log(JSON.stringify(r, null, 1));"
   ```

2. Present two lists: **observations** (model, basis, price, confidence, raw line) and
   **unresolved** lines with the parser's reason. An unresolved line is a fact to report; do not
   invent a model for it. If a genuinely new fleet model appears repeatedly, say so — the fix is a
   registry/tokenizer change with a test in `tests/pricefeed-parse.test.js`, not a manual override.

3. Compare against the sheet: for each observation, quote the sheet's used/fresh price for that
   model from the dataset and the % delta. Flag anything ≥15% either way.

4. **Ingest only if asked**, and only when `PRICEFEED_INGEST_SECRET` is available in the
   environment — never paste a secret into chat:

   ```bash
   curl -s -X POST https://cloud-miner-value-dashboard.vercel.app/api/pricefeed \
     -H "authorization: Bearer $PRICEFEED_INGEST_SECRET" -H 'content-type: application/json' \
     --data-binary @<(node -e "console.log(JSON.stringify({text: require('fs').readFileSync('.scratch/pricelist.txt','utf8'), source: 'manual'}))")
   ```

   Report `parsed / added / duplicates` from the response. Duplicates are expected when the same
   list is sent twice in a day.
