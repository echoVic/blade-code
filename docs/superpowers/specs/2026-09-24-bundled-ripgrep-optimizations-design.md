# Bundled Ripgrep Optimizations Design

**Date:** 2026-09-24
**Target:** next `blade-code` patch after 0.11.3
**Status:** Implemented and verified locally; release pending
**Capability:** Deterministic, faster search built on the ripgrep binary shipped in the npm package

## Decision summary

`blade-code` now ships ripgrep 15.2.0 for darwin-arm64, darwin-x64, linux-arm64,
linux-x64 and win32-x64. Because the bundled build has a known version and
feature set (including PCRE2), Grep, Glob and the file-name index can rely on
ripgrep features that are unsafe with an arbitrary system `rg`.

Blade will:

1. resolve ripgrep through one shared resolver that prefers the bundled binary,
   probes it once, and always passes `--no-config`;
2. make Grep use `--engine auto` (bundled binary only), `-e` for patterns that
   start with `-`, `--json` for content output, `--null` for file and count
   output, `--hidden` with version-control directories excluded, and a
   500-character, match-centred line window;
3. back Glob (files only) and the FindFiles/`@` completion index with
   `rg --files`, keeping their current matching and ignore semantics, and fall
   back to fast-glob when ripgrep is unavailable.

The design follows Claude Code's Grep/Glob/file-index behaviour where it is
reasonable, and deliberately differs where Blade's existing contracts matter
(see "Deviations from Claude Code").

## Problem

- Grep prefers the system `rg`, whose version and configuration are unknown.
  `RIPGREP_CONFIG_PATH` with `--vimgrep` leaks column numbers into results, and
  old releases (Ubuntu 20.04 ships ripgrep 11) reject newer flags.
- Look-around and back-reference patterns fail with
  `look-around ... is not supported` because the default Rust regex engine is
  used.
- A pattern that starts with `-` is parsed as a ripgrep flag.
- Content output is parsed from text, which needs a heuristic to separate paths,
  line numbers and context lines.
- Minified files can put multi-kilobyte lines into model context. In `--json`
  mode ripgrep ignores `--max-columns` (verified), so truncation must happen in
  Blade.
- Hidden files such as `.github/workflows/*.yml` are never searched.
- Glob and the file-name index walk the tree with fast-glob and a separate
  `.gitignore` scanner, which is slower on large repositories and can diverge
  from Grep's ignore handling.

## Design

### 1. Shared resolver (`src/tools/builtin/search/ripgrep.ts`)

`getRipgrep()` returns `{ command, args, bundled }` or `null`; the ordering itself lives in
the pure `chooseRipgrep()`:

1. bundled binary from `vendor/ripgrep/<platform>-<arch>`, found by walking up
   to the nearest `package.json` (existing `findVendoredRipgrep`);
2. system `rg` from `PATH`;
3. `@vscode/ripgrep`.

`BLADE_USE_BUILTIN_RIPGREP=0` (or `false`) moves the system binary first. The
bundled binary is probed once with `--version`; a binary that cannot run (for
example a glibc build on musl, or a `noexec` mount) is skipped for the rest of
the process. `args` always contains `--no-config`, which every ripgrep release
since 0.8 accepts. The resolution result is cached per process.

linux-arm64 switches to the static `aarch64-unknown-linux-musl` release so the
bundled binary also runs on musl distributions.

### 2. Grep

- ripgrep arguments: resolver `args`, `--hidden`, `--glob !<dir>` for the
  version-control directories `.git`, `.svn`, `.hg`, `.bzr`, `.jj`, `.sl` at any
  depth, the existing `--glob !<dir>/**` default exclusions, and `--engine auto`
  only when `bundled` is true.
- The pattern is always passed as `-e <pattern>`, so a leading `-` is never read
  as a flag.
- `content` mode uses `--json` (JSON events always carry line numbers). `begin`/`match`/`context`/`end` events are
  folded into the existing `GrepMatch` shape: context lines attach to the
  nearest match by line number, honouring the requested before/after counts.
  Paths and text use `text`, falling back to decoding `bytes`.
- Lines longer than 500 characters are replaced by a 500-character window
  centred on the first submatch (context lines keep their first 500
  characters), with `…[N chars omitted]…` markers.
- `files_with_matches` and `count` use `--null`; counts keep `--with-filename`.
- git grep, system grep and the JavaScript fallback keep the text parser.

### 3. Glob

When `include_directories` is false and ripgrep resolves, Glob runs
`rg --files --null --hidden --sortr=modified` plus
`--no-require-git --no-ignore-parent --no-ignore-global --no-ignore-exclude
--no-ignore-dot`, so only `.gitignore` files inside the search root apply —
exactly FileFilter's semantics, and a dotfiles-style `.gitignore` of `*` in a
parent directory cannot hide the project. It also passes:

- the current default exclusions (`DEFAULT_EXCLUDE_DIRS`,
  `DEFAULT_EXCLUDE_FILE_PATTERNS`) as negated globs anchored with a leading `/`,
  so they apply only at the search root, exactly like fast-glob;
- `.gitignore` handled natively by ripgrep (`--no-require-git` keeps it active
  outside Git repositories, as today), including `!` negations that the
  fast-glob path cannot express.

The pattern itself is **not** passed to ripgrep: `--glob` is an override that
beats `.gitignore` (verified during implementation — a gitignored
`src/generated.ts` reappeared for `**/*.ts`). The listed files are filtered
in-process with picomatch (`dot` follows `--hidden`, `nocase` follows
`case_sensitive`), the same matcher fast-glob uses.

Results are the globally newest `max_results` files (today: the first
`max_results` found, then sorted). Size and mtime come from `stat`. Directory
listings and hosts without ripgrep keep the fast-glob path.

### 4. File-name index (FindFiles and `@` completion)

`FileNameIndex` lists files with `rg --files --null` and the same ignore flags,
without
`--hidden` (today's `dot: false`), passing the default exclusions or the
caller's `ignorePatterns` as negated globs. Directory entries are derived from
the listed file paths, so empty directories no longer appear. Hosts without
ripgrep keep the fast-glob path.

## Deviations from Claude Code

- `--no-config` is passed to every ripgrep source, not only the bundled one,
  because Blade parses ripgrep output.
- Glob keeps honouring `.gitignore` (Claude Code defaults to `--no-ignore`), so
  Grep, Glob and the index agree on what is ignored.
- `--engine auto` is added for the bundled binary; Claude Code does not enable
  PCRE2.
- Long-line truncation is done in Blade and centred on the match, because
  `--max-columns` has no effect with `--json`.

## Error handling

- No ripgrep: Grep keeps its git grep → system grep → JavaScript chain; Glob and
  the index use fast-glob.
- Grep keeps today's exit-code handling: 1 (no matches) is an empty result, any
  other non-zero exit with stderr is a tool error.
- If `rg --files` fails (for example an old system `rg` without
  `--no-require-git`, added in ripgrep 11), Glob and the index fall back to
  fast-glob instead of failing.
- Aborts terminate the ripgrep child process and surface the existing abort
  error.

## Testing

Each behaviour gets a failing test first:

- resolver order, `BLADE_USE_BUILTIN_RIPGREP`, probe failure fallback and
  `--no-config`;
- Grep: `-e` for dash patterns, `--engine auto` look-around, user config
  isolation, JSON context attachment, long-line windows, hidden files and
  excluded VCS directories, `--null` file and count output;
- Glob and the index: the same fixtures produce the same results through
  ripgrep and fast-glob (top-level anchoring, case-insensitive matching,
  `.gitignore` inside and outside Git, default exclusions), plus newest-first
  ordering for Glob;
- end to end: pack, install without optional dependencies, hide system `rg`,
  and run the installed CLI's Grep and Glob through a fake model.

## Out of scope

- Permission-rule based exclusions (Claude Code's `--iglob` for denied paths).
- A win32-arm64 bundled binary.
- Removing the `@vscode/ripgrep` optional dependency.
