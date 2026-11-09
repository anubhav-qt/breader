"""
Lists the pages a round misses marked panels on (README.md), into data/hard.json, for the next round
to learn more often (train.py, PANELS_HARD). A panel is missed when no guess overlaps it as score.py
counts it: the model was unsure of it, joined it with another, or didn't see it.

    PANELS_ROUND=20 python hard.py     a given round, or the latest without it
"""

import json
import os
import sys

import cv2
from ultralytics import YOLO

from guess import guess
from pages import DATA, MODELS, write
from score import matched


def missed(marked, guessed):
    """How many marked panels no guess is matched to."""
    return len(marked) - len(matched(marked, guessed))


def main():
    n = os.environ.get("PANELS_ROUND") or json.loads((MODELS / "latest.json").read_text("utf8"))["round"]
    best = MODELS / f"round-{n}" / "best.pt"
    if not best.exists():
        sys.exit(f"No round {n}: {best} isn't there.")
    model = YOLO(str(best))
    rows = [json.loads(l) for l in (DATA / "dataset.jsonl").read_text("utf8").splitlines() if l]
    hard = {}
    for r in rows:
        picture = cv2.imread(str(DATA / r["image"]), cv2.IMREAD_COLOR)
        got = [g["quad"] for g in guess(model, picture, r["width"], r["height"])]
        k = missed(r["panels"], got)
        if k:
            hard[r["page"]] = k
    write(DATA / "hard.json", {"round": int(n), "pages": sorted(hard), "missed": hard})
    print(f"Round {n} missed {sum(hard.values())} panels on {len(hard)} of {len(rows)} pages: data/hard.json.")


if __name__ == "__main__":
    main()
