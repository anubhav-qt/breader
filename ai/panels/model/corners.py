"""
How far a round's corners land from the labelled ones, in pixels of the page (README.md): what its
score doesn't say, as a corner far off a big panel still scores well. Straight panels and slanted
ones are counted apart, since a model that learned slanted panels square is still right on the
straight ones.

  npm --prefix ai run panels-corners-mac            # the latest round
  npm --prefix ai run panels-corners-mac -- 7       # round 7
  npm --prefix ai run panels-corners-mac -- live    # model/live.onnx, as the app runs it
"""

import json
import math
import sys
from pathlib import Path

import cv2
from ultralytics import YOLO

from guess import guess, iou
from pages import DATA, MODELS, pages

# A labelled panel whose corners are this far, in pixels, from its own box's is slanted; this near, straight.
SLANTED = 30
STRAIGHT = 10


def slant(q):
    xs, ys = [x for x, _ in q], [y for _, y in q]
    return max(min(abs(x - min(xs)), abs(x - max(xs))) + min(abs(y - min(ys)), abs(y - max(ys))) for x, y in q)


def box_of(q):
    xs, ys = [x for x, _ in q], [y for _, y in q]
    return (min(xs), min(ys), max(xs), max(ys))


def share(v, p):
    v = sorted(v)
    return v[min(len(v) - 1, int(p * len(v)))] if v else float("nan")


def main():
    which = sys.argv[1] if len(sys.argv) > 1 else json.loads((MODELS / "latest.json").read_text("utf8"))["round"]
    weights = Path(__file__).parent / "live.onnx" if which == "live" else MODELS / f"round-{which}" / "best.pt"
    model = YOLO(str(weights), task="pose")
    listed = {p["id"]: p for p in pages()}
    off = {"straight": [], "slanted": []}
    missed = {"straight": 0, "slanted": 0}
    worst = []
    for f in sorted((DATA / "labels").glob("*.json")):
        label = json.loads(f.read_text("utf8"))
        page = listed.get(label["page"])
        file = DATA / "pages" / label["file"]
        picture = cv2.imread(str(file), cv2.IMREAD_COLOR) if page and file.exists() else None
        if picture is None or picture.shape[:2] != (label["height"], label["width"]):
            continue
        found = guess(model, picture, label["width"], label["height"])
        for q in label["panels"]:
            s = slant(q)
            kind = "slanted" if s > SLANTED else "straight" if s <= STRAIGHT else None
            if not kind:
                continue
            best = max(found, key=lambda g: iou(g["box"], box_of(q)), default=None)
            if not best or iou(best["box"], box_of(q)) < 0.5:
                missed[kind] += 1
                continue
            d = [math.dist(a, b) for a, b in zip(best["quad"], q)]
            off[kind] += d
            worst.append((max(d), label["page"], kind))
    print(f"Round {which}: corners off the labelled ones, in pixels")
    for kind, d in off.items():
        print(f"  {kind:8} {len(d) // 4:5} panels  median {share(d, 0.5):5.1f}  90% within {share(d, 0.9):6.1f}  missed {missed[kind]}")
    print("  furthest off:", ", ".join(f"{p} ({k}, {w:.0f})" for w, p, k in sorted(worst, reverse=True)[:8]))


if __name__ == "__main__":
    main()
