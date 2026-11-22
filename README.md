# mend: one patch tool for every AI edit format

`mend` is a command-line tool that applies the edits AI models write, in four formats, to a tree of files. It is the entry for the make.fun bounty `hidden-spec-cli-01-run-20261122`.

## Usage

```
node main.ts [options] [PATCH]
```

`PATCH` is a file, or `-` (or omitted) to read the patch from standard input. Node 22 and its standard library alone; no dependencies.

Options:

- `--format <auto|unified|search-replace|v4a|json>` — force a format (default `auto`, detected from the patch).
- `--check` — report what would change, without writing anything.
- `--strict` — match lines exactly only (tier 0); without it, matching falls back to trailing-whitespace-insensitive, then leading-and-trailing-whitespace-insensitive.

## Formats

- **Unified diff** — `diff --git` sections and bare `---`/`+++` diffs; hunks apply even when the line numbers are wrong (context lines are fuzzy-matched, nearest occurrence to the stated position wins); creates, deletes and renames (`R old -> new`).
- **SEARCH/REPLACE blocks** — `<<<<<<< SEARCH` / `=======` / `>>>>>>> REPLACE`, path from the nearest non-blank, non-fence line above the block.
- **V4A patch** — `*** Begin Patch` … `*** End Patch`, with `*** Add File:`, `*** Delete File:`, `*** Update File:` (including `*** Move to:` and anchored `@@` chunks).
- **JSON text-editor tool calls** — an array or JSON Lines of `create`, `str_replace` and `insert` commands.

## Behaviour

- Line matching runs at three tiers: exact, then trailing whitespace ignored, then leading and trailing whitespace ignored (re-indenting replacement lines at the third tier). Context lines are written as the file's own matched lines.
- All edits in a patch apply in order to the tree as earlier edits left it; if any edit fails, nothing is written and every failure is reported (`failed: <k> of <n> edits`).
- Paths are checked for safety before anything else; unsafe, missing, existing, ambiguous and non-matching edits fail per edit.
- Exit code 0 lists changed files (`A`, `D`, `M`, or `R <old> -> <new>`) then `ok: <n> files`; exit code 1 is a per-edit failure; exit code 2 is a usage, patch, format or parse error.

## Files

- `main.ts` — the CLI (the whole tool).
- `runner.ts` — kept as supplied; in a trial it reads the checks from the environment, runs `node main.ts` on each one in a fresh directory, and posts the result. `main.ts` hands a trial over to it when `MAKEFUN_ENV_URL` is set.
- `check.ts` — the practice set on your own machine:

      node check.ts ../program/generator/practice.json

  It prints every check `main.ts` gets wrong, with what differed, and the practice score.

## Verification

The practice set (`program/generator/practice.json`, 100 checks: 30 unified, 20 search-replace, 20 v4a, 15 json, 15 cli) passes in full:

```
100 of 100 passed: practice score 1000
```

## Licence

MIT — see `LICENSE`.
