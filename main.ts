// main.ts is mend, the CLI SPEC.md specifies. Node 22, the standard library alone; run it as
// `node main.ts [options] [PATCH]`. It does all of SPEC.md: the command line, the output and exit codes,
// safe paths, format detection, JSON edits, unified diffs, SEARCH/REPLACE blocks, V4A patches, line
// matching at three tiers, and the all-or-nothing write.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over
// to runner.ts (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

// ---- file lines (SPEC.md section 3) ----

interface FileState {
  lines: string[];
  br: string;
  final: boolean;
}

function splitFile(text: string): FileState {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  const final = text.endsWith(br);
  if (final) lines.pop();
  return { lines, br, final };
}

function joinFile(st: FileState): string {
  if (st.lines.length === 0) return '';
  return st.lines.join(st.br) + (st.final ? st.br : '');
}

const leadingWS = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
};
const trimEndWS = (s: string): string => s.replace(/[ \t]+$/, '');
const trimWS = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');

// ---- line matching at three tiers (SPEC.md section 5) ----

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimEndWS(a) === trimEndWS(b);
  return trimWS(a) === trimWS(b);
}

/** All 0-based positions where O occurs in `lines` at `tier` (occurrences may overlap). */
function occurrences(lines: string[], o: string[], tier: number): number[] {
  const out: number[] = [];
  if (o.length === 0) return out;
  for (let i = 0; i + o.length <= lines.length; i += 1) {
    let ok = true;
    for (let j = 0; j < o.length; j += 1) {
      if (!lineEq(o[j]!, lines[i + j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which O occurs at least once, with its occurrences; null when none. */
function findTier(lines: string[], o: string[], strict: boolean): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrences(lines, o, t);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** One line of N: a context line (index into O) or a new line (patch text). */
type NItem = { ctx: number } | { text: string };

/** Replace O at `pos` by N. Context lines are written as the file's own matched lines; at tier 2
 *  every other line of N is re-indented (F for P). */
function applyReplacement(lines: string[], o: string[], n: NItem[], pos: number, tier: number): string[] {
  let f = '';
  let p = '';
  if (tier === 2 && o.length > 0) {
    f = leadingWS(lines[pos] ?? '');
    p = leadingWS(o[0]!);
  }
  const rep: string[] = [];
  for (const item of n) {
    if ('ctx' in item) {
      rep.push(lines[pos + item.ctx]!);
    } else {
      let t = item.text;
      if (tier === 2 && t !== '' && t.trim() !== '' && t.startsWith(p)) t = f + t.slice(p.length);
      rep.push(t);
    }
  }
  return [...lines.slice(0, pos), ...rep, ...lines.slice(pos + o.length)];
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk.
 *  `moves` records newPath -> oldPath for move edits, so the output can print `R` lines. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves = new Map<string, string>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
  move(oldP: string, newP: string, content: string): void {
    this.now.set(oldP, null);
    this.now.set(newP, content);
    this.moves.set(newP, oldP);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---- unified diffs (SPEC.md section 6) ----

interface BodyItem {
  kind: 'ctx' | 'old' | 'new' | 'backslash';
  text: string;
}

interface Hunk {
  a: number;
  body: BodyItem[];
  o: string[];
  n: NItem[];
  /** Whether a `\` line follows the hunk's last context or `+` line. */
  backslashAfterLast: boolean;
}

interface USection {
  oldPath: string | null | undefined;
  newPath: string | null | undefined;
  hasHeader: boolean;
  isCreate: boolean;
  isDelete: boolean;
  hunks: Hunk[];
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** Split a hunk body into O and N, and note whether a `\` line follows the last context/`+` line. */
function bodyToON(body: BodyItem[]): { o: string[]; n: NItem[]; backslashAfterLast: boolean } {
  const o: string[] = [];
  const n: NItem[] = [];
  for (const b of body) {
    if (b.kind === 'ctx') {
      o.push(b.text);
      n.push({ ctx: o.length - 1 });
    } else if (b.kind === 'old') {
      o.push(b.text);
    } else if (b.kind === 'new') {
      n.push({ text: b.text });
    }
  }
  let last = -1;
  for (let i = 0; i < body.length; i += 1) {
    if (body[i]!.kind === 'ctx' || body[i]!.kind === 'new') last = i;
  }
  const backslashAfterLast = last >= 0 && body[last + 1]?.kind === 'backslash';
  return { o, n, backslashAfterLast };
}

function isBodyLine(l: string, next: string | undefined): boolean {
  if (l.startsWith('diff --git ')) return false;
  if (l.startsWith('--- ') && (next ?? '').startsWith('+++ ')) return false;
  return l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l.startsWith('\\');
}

function bodyItem(l: string): BodyItem {
  if (l === '') return { kind: 'ctx', text: '' };
  if (l.startsWith(' ')) return { kind: 'ctx', text: l.slice(1) };
  if (l.startsWith('-')) return { kind: 'old', text: l.slice(1) };
  if (l.startsWith('+')) return { kind: 'new', text: l.slice(1) };
  return { kind: 'backslash', text: l.slice(1) };
}

/** The path after `--- `/`+++ `: up to the first tab, surrounding spaces removed, a leading
 *  `a/` or `b/` removed; `/dev/null` means no file (null). */
function headerPath(l: string): string | null {
  let t = l.slice(4);
  const tab = t.indexOf('\t');
  if (tab >= 0) t = t.slice(0, tab);
  t = t.trim();
  if (t === '/dev/null') return null;
  if (t.startsWith('a/') || t.startsWith('b/')) t = t.slice(2);
  return t;
}

function diffGitPaths(l: string): { old: string; new: string } | null {
  const m = /^diff --git a\/(.*) b\/(.*)$/.exec(l);
  if (m === null) return null;
  return { old: m[1]!, new: m[2]! };
}

function parseUnified(lines: string[]): USection[] {
  const sections: USection[] = [];
  let cur: USection | null = null;
  let state: 'between' | 'header' | 'between-hunks' = 'between';
  let i = 0;
  const startSection = (diff: { old: string; new: string } | null): void => {
    cur = { oldPath: diff?.old, newPath: diff?.new, hasHeader: false, isCreate: false, isDelete: false, hunks: [] };
    sections.push(cur);
    state = 'header';
  };
  /** Read a hunk starting at lines[i] (`@@ ...`); returns the hunk and the index after its body. */
  const readHunk = (at: number): { hunk: Hunk; next: number } => {
    const m = HUNK_RE.exec(lines[at]!);
    if (m === null) throw new Exit2(`error: parse ${at + 1}`);
    const body: BodyItem[] = [];
    const rawEmpty: boolean[] = [];
    let j = at + 1;
    while (j < lines.length && isBodyLine(lines[j]!, lines[j + 1])) {
      body.push(bodyItem(lines[j]!));
      rawEmpty.push(lines[j] === '');
      j += 1;
    }
    // Empty patch lines at the end of a body are not part of it.
    let end = body.length;
    while (end > 0 && rawEmpty[end - 1]) end -= 1;
    const trimmed = body.slice(0, end);
    const { o, n, backslashAfterLast } = bodyToON(trimmed);
    return { hunk: { a: Number(m[1]), body: trimmed, o, n, backslashAfterLast }, next: j };
  };
  while (i < lines.length) {
    const l = lines[i]!;
    if (state === 'between' || state === 'between-hunks') {
      if (l.startsWith('diff --git ')) {
        const dg = diffGitPaths(l);
        if (dg === null) throw new Exit2(`error: parse ${i + 1}`);
        startSection(dg);
        i += 1;
      } else if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        startSection(null);
        // the ---/+++ pair is parsed as header lines on the next passes
      } else if (l.startsWith('@@')) {
        if (cur === null || state === 'between') throw new Exit2(`error: parse ${i + 1}`);
        const { hunk, next } = readHunk(i);
        cur.hunks.push(hunk);
        i = next;
        state = 'between-hunks';
      } else {
        i += 1;
      }
    } else if (state === 'header') {
      if (l.startsWith('diff --git ')) {
        const dg = diffGitPaths(l);
        if (dg === null) throw new Exit2(`error: parse ${i + 1}`);
        startSection(dg);
        i += 1;
      } else if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        if (cur!.hasHeader) {
          // A second ---/+++ pair starts a new section; the new section parses this pair next.
          startSection(null);
        } else {
          // The ---/+++ pair has priority over rename and diff --git paths.
          cur!.oldPath = headerPath(l);
          cur!.newPath = headerPath(lines[i + 1]!);
          cur!.hasHeader = true;
          i += 2;
        }
      } else if (l.startsWith('--- ')) {
        throw new Exit2(`error: parse ${i + 2}`);
      } else if (l.startsWith('@@')) {
        if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
        const { hunk, next } = readHunk(i);
        cur.hunks.push(hunk);
        i = next;
        state = 'between-hunks';
      } else if (l.startsWith('rename from ')) {
        if (cur!.oldPath === undefined) cur!.oldPath = l.slice('rename from '.length).trim();
        i += 1;
      } else if (l.startsWith('rename to ')) {
        if (cur!.newPath === undefined) cur!.newPath = l.slice('rename to '.length).trim();
        i += 1;
      } else if (l.startsWith('new file mode')) {
        cur!.isCreate = true;
        i += 1;
      } else if (l.startsWith('deleted file mode')) {
        cur!.isDelete = true;
        i += 1;
      } else {
        i += 1;
      }
    }
  }
  return sections;
}

/** Apply one hunk to a file state; returns the new state and the updated line delta d. */
function applyHunk(st: FileState, h: Hunk, d: number, strict: boolean, path: string): { state: FileState; d: number } {
  if (h.o.length === 0) {
    const idx = Math.min(h.a + d, st.lines.length);
    const added = h.n.map((x) => ('ctx' in x ? '' : x.text));
    const lines = [...st.lines.slice(0, idx), ...added, ...st.lines.slice(idx)];
    let final = st.final;
    if (idx === st.lines.length) final = !h.backslashAfterLast;
    return { state: { lines, br: st.br, final }, d: d + h.n.length };
  }
  const found = findTier(st.lines, h.o, strict);
  if (found === null) throw new Fail('no-match', path);
  const target = h.a - 1 + d;
  let pos = found.occ[0]!;
  let best = Math.abs(pos - target);
  for (const p of found.occ) {
    const dist = Math.abs(p - target);
    if (dist < best) {
      best = dist;
      pos = p;
    }
  }
  const lines = applyReplacement(st.lines, h.o, h.n, pos, found.tier);
  let final = st.final;
  if (pos + h.o.length === st.lines.length) {
    final = h.n.length === 0 ? true : !h.backslashAfterLast;
  }
  return { state: { lines, br: st.br, final }, d: d + (h.n.length - h.o.length) };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections = parseUnified(lines);
  return sections.map((s) => {
    const oldP = s.oldPath;
    const newP = s.newPath;
    const isCreate = s.isCreate || oldP === null;
    const isDelete = s.isDelete || newP === null;
    return (tree: Tree) => {
      // safety first, for every path the edit names
      for (const p of [oldP, newP]) {
        if (p !== undefined && p !== null && !safe(p)) throw new Fail('unsafe', p);
      }
      if (isCreate) {
        const np = newP as string;
        if (tree.get(np) !== null) throw new Fail('exists', np);
        const plus: string[] = [];
        for (const h of s.hunks) {
          for (const b of h.body) {
            if (b.kind === 'new') plus.push(b.text);
          }
        }
        // whether a `\` line follows the last `+` line overall
        let noBreak = false;
        for (const h of s.hunks) {
          for (let k = 0; k < h.body.length; k += 1) {
            if (h.body[k]!.kind === 'new') noBreak = h.body[k + 1]?.kind === 'backslash';
          }
        }
        if (plus.length === 0) {
          tree.now.set(np, '');
        } else {
          tree.now.set(np, plus.join('\n') + (noBreak ? '' : '\n'));
        }
        return;
      }
      if (isDelete) {
        const op = oldP as string;
        if (tree.get(op) === null) throw new Fail('missing', op);
        tree.now.set(op, null);
        return;
      }
      if (oldP !== undefined && newP !== undefined && oldP !== newP) {
        // move
        const op = oldP as string;
        const np = newP as string;
        const before = tree.get(op);
        if (before === null) throw new Fail('missing', op);
        if (tree.get(np) !== null) throw new Fail('exists', np);
        let st = splitFile(before);
        let d = 0;
        for (const h of s.hunks) {
          const r = applyHunk(st, h, d, strict, op);
          st = r.state;
          d = r.d;
        }
        tree.move(op, np, joinFile(st));
        return;
      }
      // change of the one path
      const p = (oldP ?? newP) as string;
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      let st = splitFile(before);
      let d = 0;
      for (const h of s.hunks) {
        const r = applyHunk(st, h, d, strict, p);
        st = r.state;
        d = r.d;
      }
      tree.now.set(p, joinFile(st));
    };
  });
}

// ---- SEARCH/REPLACE blocks (SPEC.md section 7) ----

interface SRBlock {
  path: string;
  searchLine: number;
  old: string[];
  new: string[];
}

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const blocks: SRBlock[] = [];
  let prevEnd = -1; // index just after the previous block's REPLACE line
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchLine = i + 1;
    // find ======= then >>>>>>> REPLACE
    let sep = -1;
    let end = -1;
    for (let j = i + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '=======') {
        sep = j;
        break;
      }
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') break;
    }
    if (sep < 0) throw new Exit2(`error: parse ${searchLine}`);
    for (let j = sep + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        end = j;
        break;
      }
    }
    if (end < 0) throw new Exit2(`error: parse ${searchLine}`);
    // the path: nearest line before SEARCH, after the previous block's REPLACE (or patch start),
    // that is not blank and does not start with three backticks (surrounding whitespace removed)
    let path: string | null = null;
    for (let j = i - 1; j > prevEnd; j -= 1) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${searchLine}`);
    blocks.push({ path, searchLine, old: lines.slice(i + 1, sep), new: lines.slice(sep + 1, end) });
    prevPath = path;
    prevEnd = end;
    i = end + 1;
  }
  return blocks.map((b) => {
    const p = b.path;
    const oldLines = b.old;
    const newLines = b.new;
    return (tree: Tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (oldLines.length === 0) {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, newLines.length === 0 ? '' : `${newLines.join('\n')}\n`);
        return;
      }
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      const st = splitFile(before);
      const found = findTier(st.lines, oldLines, strict);
      if (found === null) throw new Fail('no-match', p);
      if (found.occ.length > 1) throw new Fail('ambiguous', p);
      const pos = found.occ[0]!;
      const nItems: NItem[] = newLines.map((t) => ({ text: t }));
      const lines2 = applyReplacement(st.lines, oldLines, nItems, pos, found.tier);
      tree.now.set(p, joinFile({ lines: lines2, br: st.br, final: st.final }));
    };
  });
}

// ---- V4A patches (SPEC.md section 8) ----

type VChunk = { anchor: string | null; body: BodyItem[]; o: string[]; n: NItem[]; eof: boolean };
type VSection =
  | { kind: 'add'; path: string; lines: string[] }
  | { kind: 'delete'; path: string }
  | { kind: 'update'; path: string; moveTo: string | null; chunks: VChunk[]; updateLine: number };

const V_ADD = '*** Add File: ';
const V_DEL = '*** Delete File: ';
const V_UPD = '*** Update File: ';
const V_MOVE = '*** Move to: ';

function isVSectionStart(l: string): boolean {
  return l.startsWith(V_ADD) || l.startsWith(V_DEL) || l.startsWith(V_UPD);
}

function parseV4A(lines: string[]): VSection[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k -= 1) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: VSection[] = [];
  let i = first + 1;
  while (i < last) {
    if (blank(lines[i]!)) {
      i += 1;
      continue;
    }
    const l = lines[i]!;
    if (l.startsWith(V_ADD)) {
      const path = l.slice(V_ADD.length).trim();
      const content: string[] = [];
      let j = i + 1;
      while (j < last && !isVSectionStart(lines[j]!)) {
        content.push(lines[j]!);
        j += 1;
      }
      while (content.length > 0 && blank(content[content.length - 1]!)) content.pop();
      const fileLines: string[] = [];
      for (let k = 0; k < content.length; k += 1) {
        const cl = content[k]!;
        if (cl === '') fileLines.push('');
        else if (cl.startsWith('+')) fileLines.push(cl.slice(1));
        else throw new Exit2(`error: parse ${i + 2 + k}`);
      }
      sections.push({ kind: 'add', path, lines: fileLines });
      i = j;
    } else if (l.startsWith(V_DEL)) {
      const path = l.slice(V_DEL.length).trim();
      sections.push({ kind: 'delete', path });
      i += 1;
    } else if (l.startsWith(V_UPD)) {
      const path = l.slice(V_UPD.length).trim();
      const updateLine = i + 1;
      const content: string[] = [];
      let j = i + 1;
      while (j < last && !isVSectionStart(lines[j]!)) {
        content.push(lines[j]!);
        j += 1;
      }
      while (content.length > 0 && blank(content[content.length - 1]!)) content.pop();
      let moveTo: string | null = null;
      let idx = 0;
      if (content.length > 0 && content[0]!.startsWith(V_MOVE)) {
        moveTo = content[0]!.slice(V_MOVE.length).trim();
        idx = 1;
      }
      const chunks: VChunk[] = [];
      while (idx < content.length) {
        const cl = content[idx]!;
        if (cl.startsWith('@@')) {
          const anchor = cl.slice(2).trim();
          chunks.push({ anchor: anchor === '' ? null : anchor, body: [], o: [], n: [], eof: false });
          idx += 1;
        } else if (cl === '*** End of File') {
          if (chunks.length === 0) throw new Exit2(`error: parse ${i + 2 + idx}`);
          chunks[chunks.length - 1]!.eof = true;
          idx += 1;
        } else if (cl.startsWith(' ') || cl.startsWith('-') || cl.startsWith('+') || cl === '') {
          if (chunks.length === 0) chunks.push({ anchor: null, body: [], o: [], n: [], eof: false });
          chunks[chunks.length - 1]!.body.push(bodyItem(cl));
          idx += 1;
        } else {
          throw new Exit2(`error: parse ${i + 2 + idx}`);
        }
      }
      for (const ch of chunks) {
        const { o, n } = bodyToON(ch.body);
        ch.o = o;
        ch.n = n;
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateLine}`);
      sections.push({ kind: 'update', path, moveTo, chunks, updateLine });
      i = j;
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
  }
  return sections;
}

/** Find the first line at or after `from` equal to a single-line anchor at the first tier with one. */
function findAnchor(lines: string[], anchor: string, from: number, strict: boolean): number | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    for (let k = from; k < lines.length; k += 1) {
      if (lineEq(anchor, lines[k]!, t)) return k;
    }
  }
  return null;
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const sections = parseV4A(lines);
  return sections.map((s) => {
    if (s.kind === 'add') {
      const p = s.path;
      const fileLines = s.lines;
      return (tree: Tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, fileLines.length === 0 ? '' : `${fileLines.join('\n')}\n`);
      };
    }
    if (s.kind === 'delete') {
      const p = s.path;
      return (tree: Tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
      };
    }
    const p = s.path;
    const moveTo = s.moveTo;
    const chunks = s.chunks;
    return (tree: Tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
      const st = splitFile(before);
      let cur = st.lines;
      let cursor = 0;
      for (const ch of chunks) {
        if (ch.anchor !== null) {
          const at = findAnchor(cur, ch.anchor, cursor, strict);
          if (at === null) throw new Fail('no-match', p);
          cursor = at + 1;
        }
        if (ch.o.length === 0) {
          const idx = ch.eof ? cur.length : cursor;
          const added = ch.n.map((x) => ('ctx' in x ? '' : x.text));
          cur = [...cur.slice(0, idx), ...added, ...cur.slice(idx)];
          cursor = idx + added.length;
          continue;
        }
        // first occurrence of O at or after the cursor, at the first tier with one
        const tiers = strict ? [0] : [0, 1, 2];
        let found: { tier: number; pos: number } | null = null;
        for (const t of tiers) {
          const occ = occurrences(cur, ch.o, t).filter((pos) => pos >= cursor);
          const good = ch.eof ? occ.filter((pos) => pos + ch.o.length === cur.length) : occ;
          if (good.length > 0) {
            found = { tier: t, pos: good[0]! };
            break;
          }
        }
        if (found === null) throw new Fail('no-match', p);
        cur = applyReplacement(cur, ch.o, ch.n, found.pos, found.tier);
        cursor = found.pos + ch.n.length;
      }
      const out = joinFile({ lines: cur, br: st.br, final: st.final });
      if (moveTo !== null) tree.move(p, moveTo, out);
      else tree.now.set(p, out);
    };
  });
}

// ---- command line, output and the all-or-nothing write (SPEC.md sections 1, 2, 10) ----

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines, strict);
    else if (kind === 'v4a') edits = v4aEdits(lines, strict);
    else edits = [];
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const beforeMoves = new Map(tree.moves);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.clear();
      for (const [k, v] of beforeMoves) tree.moves.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // Changed paths, with move pairs reported as `R <old> -> <new>` (sorted by <new>).
  const changed = new Map<string, { was: string | null; now: string | null }>();
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was !== now) changed.set(p, { was, now });
  }
  const consumed = new Set<string>();
  const rows: { key: string; text: string }[] = [];
  for (const [newP, oldP] of tree.moves) {
    let src = oldP;
    const seen = new Set<string>([newP]);
    while (tree.moves.has(src) && !seen.has(src)) {
      seen.add(src);
      src = tree.moves.get(src)!;
    }
    const c = changed.get(newP);
    const s = changed.get(src);
    if (c !== undefined && c.was === null && c.now !== null && s !== undefined && s.was !== null && s.now === null) {
      rows.push({ key: newP, text: `R ${src} -> ${newP}` });
      consumed.add(newP);
      consumed.add(src);
    }
  }
  for (const [p, c] of changed) {
    if (consumed.has(p)) continue;
    const k = c.was === null ? 'A' : c.now === null ? 'D' : 'M';
    rows.push({ key: p, text: `${k} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
      const now = tree.now.get(p)!;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
