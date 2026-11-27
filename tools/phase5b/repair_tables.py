"""Phase 5b v1.1 prototype (version 2): repair table rows in `pdftotext -layout` text. Deterministic, no model calls.

Problem: in narrow table columns a cell wraps over several lines, so one figure such as 26,964,532.92 is stored as
'26,964,532.9' on one line and '2' two lines further down, and the cells of one row are spread over 3 to 5 lines.
Method, applied only to table-like blocks (consecutive non-blank lines with at least one figure and a line with at least two
wide gaps between cells; at most 14 lines). Text outside such blocks is not changed.
  1. Each line is cut into cells: words separated by at most two spaces belong to one cell.
  2. Cells of different lines whose horizontal positions overlap form one column (two cells of one line never share a column).
  3. Columns are read left to right; inside a column, top to bottom.
  4. Fragments of one wrapped word or figure are joined without a space: a short digit group below an incomplete figure
     only if the result is a well-formed figure (thousands groups of 3, 0 or 2 decimals); one or two lowercase letters below
     a word (Morocc + o), one capital below an all-capitals word (ANDZO + A).
  5. If a header block (Committed Amount, Disbursed Amount, ...) precedes the rows in the same section, each figure is
     written as 'Header: figure' using the header column that lies above it.
  6. The row is written as ONE line, prefixed with the last section heading before it in square brackets, for example
     '[E.1. GCF financing] Morocco Grants USD 26,964,532.92 ...'. The prefix is reader-added context and says so in the spec.
Usage: repair_tables.py in.txt out.txt"""
import re, sys

CELL = re.compile(r"\S+(?: {1,2}\S+)*")
NUM_FULL = re.compile(r"^\d{1,3}(,\d{3})*(\.\d{2})?%?$|^\d+(\.\d{2})?%?$")
NUM_BROKEN = re.compile(r"^\d{1,3}(,\d{1,2}|(,\d{3})*\.\d)$|^\d{1,3}(,\d{3})*,\d{1,2}$|^\d{1,3}(,\d{3})+\.$")
NUM_LIKE = re.compile(r"^\(?\d[\d,.]*%?\)?$")
HEADING = re.compile(r"^\s*((?:[A-Z]\.\d{1,2}\.?|[A-Z]\.|\d{1,2}\.\d{1,2}\.?)\s+[A-Z(\[].*?)\s*$")
SHORT_WORDS = {"of", "in", "to", "on", "by", "at", "as", "an", "or", "is", "it", "be", "no", "vs", "and", "the"}

def table_like(lines: list[str]) -> bool:
    if len(lines) > 14: return False
    nums = sum(1 for l in lines for w in l.split() if NUM_LIKE.match(w))
    gaps = max((len(re.findall(r"\S {4,}\S", l)) for l in lines), default=0)
    return nums >= 1 and (gaps >= 2 or (gaps >= 1 and 2 <= len(lines) <= 4 and all(len(l.strip()) <= 90 for l in lines)))

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

HEADER_WORDS = re.compile(r"committed|disburs|expenditur|amount|instrument|currency|tenor|pricing|mitigatio|adaptatio|country|co-financier", re.I)
FIGURE = re.compile(r"^[\(\[]?\d[\d,.]*%?[\)\]]?$")

def columns(lines: list[str]) -> list[dict]:
    cells = []  # [line, start, end, text]
    for i, l in enumerate(lines):
        for m in CELL.finditer(l): cells.append([i, m.start(), m.end(), m.group()])
    cols: list[dict] = []
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
    for col in cols:
        col["parts"] = join_fragments([m[3] for m in sorted(col["members"], key=lambda m: m[0])])
    return cols

def header_labels(lines: list[str]) -> list[tuple[int, int, str]]:
    out = []
    for col in columns(lines):
        label = " ".join(col["parts"]).strip()
        if label and len(label) <= 45 and not FIGURE.match(label): out.append((col["s"], col["e"], label))
    return out

def is_header(lines: list[str]) -> bool:
    if len(lines) > 8: return False
    text = " ".join(lines)
    if any(FIGURE.match(w) for w in text.split() if len(w) > 3 and "," in w): return False
    return len(set(w.lower() for w in HEADER_WORDS.findall(text))) >= 2

def margin_label(lines: list[str]) -> str:
    """Row label at the left margin that starts with (a), (b), ... and wraps over later lines, e.g. '(b) GCF financing to
    recipient'. The label cells are those that start within two columns of the left edge; lines that are indented (the
    cells of the other columns) lie between them, so the continuation lines need not follow each other."""
    for k, l0 in enumerate(lines):
        first = CELL.match(l0.lstrip()) if not l0.startswith(" " * 4) else None
        if first and re.match(r"^\([a-h]\)", first.group()): break
    else: return ""
    parts = [first.group()]
    for l in lines[k + 1:]:
        if l.startswith(" " * 5): continue
        m = CELL.match(l.lstrip())
        if not m or re.match(r"^\(", m.group()) or FIGURE.match(m.group().split()[0]): break
        parts.append(m.group())
    return re.sub(r"\b(Co)- (?=[a-z])", r"\1-", " ".join(parts)) if len(parts) <= 6 else ""

def repair_block(lines: list[str], header: list[tuple[int, int, str]] | None = None) -> str:
    row = []
    for col in columns(lines):
        for part in col["parts"]:
            if header and FIGURE.match(part):
                best, best_ov = None, 0
                for hs, he, label in header:
                    ov = min(col["e"], he + 3) - max(col["s"], hs - 3)
                    if ov > best_ov: best, best_ov = label, ov
                if best: part = f"{best}: {part}"
            row.append(part)
    return re.sub(r"\b(Co)- (?=[a-z])", r"\1-", " ".join(row))

def repair(text: str) -> tuple[str, int]:
    out, block, n, heading, header, label, fresh = [], [], 0, "", None, "", False
    def split(lines: list[str]) -> list[list[str]]:
        segs, cur = [], []
        for l in lines:
            is_head = bool(HEADING.match(l)) and len(l.split()) <= 14 and not re.search(r"\d{1,3},\d{3}", l)
            is_row = len(lines) > 14 and bool(re.match(r"^\s*\((?:[ivx]+|[a-z])\)\s", l))
            is_label = bool(re.match(r"^ {0,2}\([a-h]\)\s", l)) and any(NUM_LIKE.match(w) for x in cur for w in x.split())
            if (is_head or is_row or is_label) and cur: segs.append(cur); cur = []
            cur.append(l)
        if cur: segs.append(cur)
        return segs
    def flush():
        if not block: return
        segs = split(block); block.clear()
        for sg in segs: flush_one(sg)
    def flush_one(block):
        nonlocal n, heading, header, label, fresh
        if not block: return
        # heading lines in front of a table stay as they are, so the section cutter and the reader still see them
        while block and (m := HEADING.match(block[0])) and len(block[0].split()) <= 14 and not re.search(r"\d{1,3},\d{3}", block[0]) and not table_like(block[:1]):
            out.append(block.pop(0)); heading = re.sub(r"\s+", " ", m.group(1)); header = None; label = ""
        if not block: return
        if table_like(block):
            own = margin_label(block)
            # a label is carried only to a total row or an enumerated row, which belong to the label above them; a label in a tall
            # cell is centred, so an unnumbered row above the next label may belong to that next label instead
            carried = label if (not own and (fresh or re.match(r"^\s*(Total\b|\((?:[ivx]+)\))", block[0]))) else ""
            fresh = False
            if own: label = own
            r = repair_block(block, header)
            pre = heading[:70] + (" > " + carried if carried else "") if heading else carried
            out.append((f"[{pre}] " if pre else "") + r); n += 1
        else:
            out.extend(block)
            own = margin_label(block)
            if own: label = own; fresh = True
            if is_header(block): header = header_labels(block)
            for l in block:
                m = HEADING.match(l)
                if m and len(l.split()) <= 14 and not re.search(r"\d{1,3},\d{3}", l): heading = re.sub(r"\s+", " ", m.group(1)); header = None; label = ""
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
