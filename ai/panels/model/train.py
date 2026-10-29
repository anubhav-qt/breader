"""
Trains the next round of the panel model on every labelled page (README.md), then guesses the pages
not labelled yet with it, for the labeller to start from.

It learns from data/dataset.jsonl, which the export writes after checking every label against its
picture (npm runs it first), so the model sees the labels exactly as saved. Each round starts again
from the same weights (BASE), and is kept in data/model/round-N: its weights, how training went, and
the pages it learned from.

The model finds each panel's box and its four corners, in the order they're labelled, so a slanted
panel comes back slanted.
"""

import json
import os
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path

import cv2
import ultralytics
from ultralytics import YOLO

import guess
from pages import DATA, DEVICE, MODELS, SIZE, windows, write

# The pictures cut and listed the way YOLO reads them, in the container or the Mac's /tmp.
WORK = Path("/tmp/yolo")
# The weights each round starts from: YOLO's trained on photos, or a kept round's (PANELS_BASE=round-6)
# when the pages that round learned from aren't here to be learned from again.
BASE = os.environ.get("PANELS_BASE", "yolo11s-pose.pt")
EPOCHS = 200
# A panel cut down to less than this, in pixels, by a strip's window isn't one in that window.
LEAST = 8
# How far off a corner may be, as a share of its panel's size, before it costs (Ultralytics' OKS
# sigma, for the loss and the score). Its own for 4 corners is 1/4, so a corner 80 px off a 600 px
# panel scored 0.97 and slanted panels were learned square (round 7); at 0.08 it scores 0.71.
SIGMA = 0.08


def lines():
    f = DATA / "dataset.jsonl"
    if not f.exists():
        sys.exit("No data/dataset.jsonl: run npm --prefix ai run panels-export first.")
    return [json.loads(l) for l in f.read_text("utf8").splitlines() if l]


def yolo_line(quad, top, w, h):
    """A panel in a window from `top`, as a line of YOLO's: its box, then its corners, all 0 to 1."""
    # Cut by the window: each corner kept inside it, across as it was.
    pts = [(x, min(max(y - top, 0), h)) for x, y in quad]
    xs, ys = [p[0] for p in pts], [p[1] for p in pts]
    x0, x1, y0, y1 = min(xs), max(xs), min(ys), max(ys)
    if x1 - x0 < LEAST or y1 - y0 < LEAST:
        return None
    box = f"{(x0 + x1) / 2 / w:.6f} {(y0 + y1) / 2 / h:.6f} {(x1 - x0) / w:.6f} {(y1 - y0) / h:.6f}"
    # Every corner seen (2): they're all on the page, if sometimes on its edge.
    corners = " ".join(f"{x / w:.6f} {y / h:.6f} 2" for x, y in pts)
    return f"0 {box} {corners}"


def dataset(rows):
    """Writes the labelled pages out for YOLO, a strip a window at a time, and says how many pictures."""
    shutil.rmtree(WORK, ignore_errors=True)
    images, labels = WORK / "images" / "train", WORK / "labels" / "train"
    images.mkdir(parents=True)
    labels.mkdir(parents=True)
    count = 0
    for row in rows:
        picture = cv2.imread(str(DATA / row["image"]), cv2.IMREAD_COLOR)
        if picture is None or picture.shape[:2] != (row["height"], row["width"]):
            sys.exit(f"{row['image']} doesn't read as the {row['width']}x{row['height']} picture labelled.")
        for k, (top, bottom) in enumerate(windows(row["width"], row["height"])):
            name = f"{row['page']}-{k}"
            # Lossless, so the model learns from the picture as labelled.
            cv2.imwrite(str(images / f"{name}.png"), picture[top:bottom])
            found = [yolo_line(q, top, row["width"], bottom - top) for q in row["panels"]]
            (labels / f"{name}.txt").write_text("".join(f"{l}\n" for l in found if l))
            count += 1
    # The corners mirror in pairs when a page is flipped: top left with top right, bottom right
    # with bottom left. Every page is looked at again to judge each epoch: too few to hold any back,
    # and the real test is the next pages labelled, which the model has never seen.
    (WORK / "panels.yaml").write_text(
        f"path: {WORK}\ntrain: images/train\nval: images/train\n"
        f"kpt_shape: [4, 3]\nflip_idx: [1, 0, 3, 2]\nkpt_oks_sigmas: {[SIGMA] * 4}\nnames:\n  0: panel\n"
    )
    return count


def main():
    rows = lines()
    if not rows:
        sys.exit("No labelled pages yet: label a few first.")
    done = [int(p.name.split("-")[1]) for p in MODELS.glob("round-*") if p.name.split("-")[1].isdigit()]
    n = max(done, default=0) + 1
    pictures = dataset(rows)
    panels = sum(len(r["panels"]) for r in rows)
    print(f"Round {n}: {len(rows)} labelled pages, {panels} panels, as {pictures} pictures.", flush=True)

    base = BASE
    if BASE.startswith("round-"):
        base = str(MODELS / BASE / "best.pt")
    model = YOLO(base)
    model.train(
        data=str(WORK / "panels.yaml"),
        epochs=EPOCHS,
        patience=EPOCHS,
        imgsz=SIZE,
        batch=8,
        device=DEVICE,
        workers=4,
        project="/tmp/runs",
        name="round",
        exist_ok=True,
        seed=0,
        plots=False,
        # Pages are drawn upright, so they're flipped across, never upside down or turned.
        fliplr=0.5,
        flipud=0.0,
        degrees=0.0,
    )
    run = Path(model.trainer.save_dir)

    out = MODELS / f"round-{n}"
    out.mkdir(parents=True, exist_ok=True)
    shutil.copy(model.trainer.best, out / "best.pt")
    if (run / "results.csv").exists():
        shutil.copy(run / "results.csv", out / "results.csv")
    write(
        out / "round.json",
        {
            "round": n,
            "made": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "base": BASE,
            "ultralytics": ultralytics.__version__,
            "size": SIZE,
            "epochs": EPOCHS,
            "panels": panels,
            "pages": [r["page"] for r in rows],
        },
    )
    write(MODELS / "latest.json", {"round": n})
    print(f"Round {n} kept in data/model/round-{n}.", flush=True)
    guess.main()


if __name__ == "__main__":
    main()
