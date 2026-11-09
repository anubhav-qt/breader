"""
Scores a round of the panel model against the labels (README.md): it guesses every labelled page
the way guess.py does, and measures each guess against what was marked, in the page's own pixels.
On the pages a round learned from, this says how closely it fits them; on pages labelled since,
how well it does on pages it has never seen.

    PANELS_ROUND=7 python score.py     a given round, or the latest without it

Writes data/model/round-N/score.json and prints the summary.
"""

import json
import os
import statistics
import sys

import cv2
from ultralytics import YOLO

from guess import guess, iou
from pages import DATA, MODELS, write

# A guess is the marked panel it overlaps most, if they overlap at least this much.
SAME = 0.5
# Corners within this many pixels of what was marked count as right.
CLOSE = (3, 5, 10)


def box_of(q):
    xs, ys = [p[0] for p in q], [p[1] for p in q]
    return (min(xs), min(ys), max(xs), max(ys))


def matched(marked, guessed):
    """Pairs of (marked, guessed) index, surest overlap first, each once."""
    pairs = sorted(
        ((iou(box_of(m), box_of(g)), i, j) for i, m in enumerate(marked) for j, g in enumerate(guessed)),
        reverse=True,
    )
    used_m, used_g, out = set(), set(), []
    for o, i, j in pairs:
        if o < SAME:
            break
        if i in used_m or j in used_g:
            continue
        used_m.add(i)
        used_g.add(j)
        out.append((i, j))
    return out


def off(m, g):
    """How far a guessed panel's corners are from the marked ones, in pixels: the furthest, and on average."""
    d = [((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2) ** 0.5 for a, b in zip(m, g)]
    return max(d), sum(d) / 4


def pct(n, of):
    return round(100 * n / of, 1) if of else 0.0


def summary(rows):
    """What the per-panel rows add up to: how far off."""
    if not rows:
        return {}
    worst = sorted(r["worst"] for r in rows)
    return {
        "panels": len(rows),
        "worst corner px, median": round(statistics.median(worst), 1),
        "worst corner px, 90th": round(worst[int(0.9 * (len(worst) - 1))], 1),
        **{f"all corners within {c}px %": pct(sum(w <= c for w in worst), len(worst)) for c in CLOSE},
    }


def main():
    asked = os.environ.get("PANELS_ROUND")
    n = int(asked) if asked else json.loads((MODELS / "latest.json").read_text("utf8"))["round"]
    out = MODELS / f"round-{n}"
    model = YOLO(str(out / "best.pt"))
    learned = set()
    if (out / "round.json").exists():
        learned = set(json.loads((out / "round.json").read_text("utf8"))["pages"])
    f = DATA / "dataset.jsonl"
    if not f.exists():
        sys.exit("No data/dataset.jsonl: run npm --prefix ai run panels-export first.")
    rows = [json.loads(l) for l in f.read_text("utf8").splitlines() if l]

    result = {}
    for part, pages in (("learned from", [r for r in rows if r["page"] in learned]), ("never seen", [r for r in rows if r["page"] not in learned])):
        if not pages:
            continue
        panels, missed, extra, in_order, spot_on, worst_pages = [], 0, 0, 0, 0, []
        for row in pages:
            picture = cv2.imread(str(DATA / row["image"]), cv2.IMREAD_COLOR)
            guessed = [g["quad"] for g in guess(model, picture, row["width"], row["height"])]
            marked = row["panels"]
            pairs = matched(marked, guessed)
            missed += len(marked) - len(pairs)
            extra += len(guessed) - len(pairs)
            page_worst = 0
            for i, j in pairs:
                worst, mean = off(marked[i], guessed[j])
                page_worst = max(page_worst, worst)
                panels.append({"worst": worst, "mean": mean})
            # Read in the marked order: the guesses' order of the panels both have.
            order = [j for _, j in sorted(pairs)]
            in_order += order == sorted(order) and len(pairs) == len(marked)
            whole = len(pairs) == len(marked) == len(guessed)
            spot_on += whole and page_worst <= 5
            worst_pages.append((len(marked) - len(pairs) + len(guessed) - len(pairs), round(page_worst, 1), row["page"]))
        marked_total = sum(len(r["panels"]) for r in pages)
        result[part] = {
            "pages": len(pages),
            "panels marked": marked_total,
            "found %": pct(marked_total - missed, marked_total),
            "extra guesses": extra,
            "pages read in the marked order %": pct(in_order, len(pages)),
            "pages spot on % (every panel, none extra, every corner within 5px)": pct(spot_on, len(pages)),
            "all": summary(panels),
            "worst pages (missed + extra, worst corner px)": [f"{p}: {m} wrong, {w}px" for m, w, p in sorted(worst_pages, reverse=True)[:15]],
        }
    write(out / "score.json", {"round": n, **result})
    print(json.dumps({"round": n, **result}, indent=1))


if __name__ == "__main__":
    main()
