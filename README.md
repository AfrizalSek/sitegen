# sitegen

[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

A faster drop-in for make.fun's own makefun-site 1.0.0. It answers exactly as
makefun-site does on every case — byte for byte — and does it faster.

## Run it

```sh
node main.ts
```

`main.ts` (the house driver, kept as shipped) reads every case from
`/input/cases.json`, answers each one with `run()` from `solve.js`, and writes
`/output/answers.json`. Outside a container, `MAKEFUN_INPUT_DIR` and
`MAKEFUN_OUTPUT_DIR` stand in for `/input` and `/output`.

## How it is faster

`solve.js` is a from-scratch reimplementation of makefun-site 1.0.0's build,
written for speed while keeping every observable behaviour identical:

- **Chunked HTML escaping** — one native replace per run of plain text,
  instead of a replace per character.
- **Fused Markdown lex + render** — blocks are rendered as they are scanned,
  with no token objects and no second pass.
- **Fast slugs** — an ASCII fast path (plus a per-run cache) for
  `slugify`, which the reference calls repeatedly for the same titles and
  tags; the full NFKD path is kept for non-ASCII text.
- **Scan-based word counting**, counted while a body is still hot in the
  Markdown pass, instead of a regex match array per page.
- **Memoized template includes** — an include whose result is fixed by the
  values it reads (the site, its tags, its recent posts, a post's card) is
  rendered once per case and reused; includes that read a fresh per-page
  value are never memoized.
- **Cached links, dates and slugs** — all caches live inside one `run()`
  call: nothing is kept from one case to the next, as the rules require.

## Verification

- Practice set: 3/3 cases byte-identical to makefun-site 1.0.0's answers.
- Differential test: 24 further cases drawn from the kit's own generator
  (fresh seeds), 0 mismatches against the reference build.
- Paired timing on the practice set (14 rounds, alternating order, CPU time
  per 3-case set): baseline ~540–620 ms, this entry ~160–230 ms depending on
  machine load — roughly 3x faster, and faster than the baseline at 95%
  confidence in every paired run (the paired difference's 95% interval
  stays far above zero).

## License

MIT — see `LICENSE`.
