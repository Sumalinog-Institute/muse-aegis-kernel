"""Phase 5b v1.1 prototype (version 2): repair table rows in `pdftotext -layout` text. Deterministic, no model calls.

Problem: in narrow table columns a cell wraps over several lines, so one figure such as 26,964,532.92 is stored as
'26,964,532.9' on one line and '2' two lines further down, and the cells of one row are spread over 3 to 5 lines.
Method, applied only to table-like blocks (consecutive non-blank lines with at least one figure and a line with at least two
wide gaps between cells; at most 8 lines). Text outside such blocks is not changed.
  1. Each line is cut into cells: words separated by at most two spaces belong to one cell.
  2. Cells of different lines whose horizontal positions overlap form one column (two cells of one line never share a column).
  3. Columns are read left to right; inside a column, top to bottom.
  4. Fragments of one wrapped word or figure are joined without a space: a short digit group below an incomplete figure
     only if the result is a well-formed figure (thousands groups of 3, 0 or 2 decimals); one or two lowercase letters below
     a word (Morocc + o), one capital below an all-capitals word (ANDZO + A).
  5. The row is written as ONE line, prefixed with the last section heading before it in square brackets, for example
     '[E.1. GCF financing] Morocco Grants USD 26,964,532.92 ...'. The prefix is reader-added context and says so in the spec.
Usage: repair_tables.py in.txt out.txt"""
import re, sys

CELL = re.compile(r"\S+(?: {1,2}\S+)*")
NUM_FULL = re.compile(r"^\d{1,3}(,\d{3})*(\.\d{2})?%?$|^\d+(\.\d{2})?%?$")
NUM_BROKEN = re.compile(r"^\d{1,3}(,\d{1,2}|(,\d{3})*\.\d)$|^\d{1,3}(,\d{3})*,\d{1,2}$")
NUM_LIKE = re.compile(r"^\(?\d[\d,.]*%?\)?$")
HEADING = re.compile(r"^\s*((?:[A-Z]\.\d+\.?|[A-Z]\.|\d+\.\d+\.?)\s+\S.*?)\s*$")
SHORT_WORDS = {"of", "in", "to", "on", "by", "at", "as", "an", "or", "is", "it", "be", "no", "vs", "and", "the"}

def table_like(lines: list[str]) -> bool:
    if len(lines) > 8: return False
    nums = sum(1 for l in lines for w in l.split() if NUM_LIKE.match(w))
    gaps = max((len(re.findall(r"\S {4,}\S", l)) for l in lines), default=0)
    return nums >= 1 and gaps >= 2

def join_fragments(parts: list[str]) -> list[str]:
    """parts: texts of one column, top to bottom. Joins wrapped fragments without a space."""
    out: list[str] = []
    for p in parts:
        if out:
            prev = out[-1]; last = prev.split(" ")[-1]; first = p.split(" ")[0]
            if NUM_BROKEN.match(last) and re.fullmatch(r"\d{1,3}", first) and NUM_FULL.match(last + first):
                out[-1] = prev + first; rest = p[len(first):].lstrip()
                if rest: out.append(rest)
                continue
            if re.fullmatch(r"[A-Za-z]{4,}", last) and re.fullmatch(r"[a-z]{1,2}", first) and first not in SHORT_WORDS and not last.islower():
                out[-1] = prev + first; rest = p[len(first):].lstrip()
                if rest: out.append(rest)
                continue
            if re.fullmatch(r"[A-Z]{4,}", last) and re.fullmatch(r"[A-Z]", first):
                out[-1] = prev + first; rest = p[len(first):].lstrip()
                if rest: out.append(rest)
                continue
        out.append(p)
    return out

def repair_block(lines: list[str]) -> str:
    cells = []  # [line, start, end, text]
    for i, l in enumerate(lines):
        for m in CELL.finditer(l): cells.append([i, m.start(), m.end(), m.group()])
    cols: list[dict] = []  # each: span [s, e], members
    for c in sorted(cells, key=lambda c: (c[1], c[0])):
        best, best_ov = None, 0
        for col in cols:
            if any(m[0] == c[0] for m in col["members"]): continue
            ov = min(c[2], col["e"] + 1) - max(c[1], col["s"] - 1)
            if ov > best_ov: best, best_ov = col, ov
        if best is None: cols.append({"s": c[1], "e": c[2], "members": [c]})
        else:
            best["members"].append(c); best["s"] = min(best["s"], c[1]); best["e"] = max(best["e"], c[2])
    cols.sort(key=lambda col: (col["s"] + col["e"]) / 2)
    row = []
    for col in cols:
        parts = [m[3] for m in sorted(col["members"], key=lambda m: m[0])]
        row.extend(join_fragments(parts))
    return " ".join(row)

def repair(text: str) -> tuple[str, int]:
    out, block, n, heading = [], [], 0, ""
    def flush():
        nonlocal n, heading
        if not block: return
        # heading lines in front of a table stay as they are, so the section cutter and the reader still see them
        while block and (m := HEADING.match(block[0])) and len(block[0].split()) <= 14 and not re.search(r"\d{1,3},\d{3}", block[0]) and not table_like(block[:1]):
            out.append(block.pop(0)); heading = m.group(1)
        if not block: return
        if table_like(block):
            r = repair_block(block)
            out.append((f"[{heading[:70]}] " if heading else "") + r); n += 1
        else:
            out.extend(block)
            for l in block:
                m = HEADING.match(l)
                if m and len(l.split()) <= 14 and not re.search(r"\d{1,3},\d{3}", l): heading = m.group(1)
        block.clear()
    for l in text.split("\n"):
        if l.strip() == "": flush(); out.append(l)
        else: block.append(l)
    flush()
    return "\n".join(out), n

if __name__ == "__main__":
    s = open(sys.argv[1], errors="replace").read()
    r, n = repair(s)
    open(sys.argv[2], "w").write(r)
    print(f"{sys.argv[1]}: {n} table blocks rewritten")
