"""
Trains the next round of the panel model on every labelled page (README.md), then guesses the pages
not labelled yet with it, for the labeller to start from.

It learns from data/dataset.jsonl, which the export writes after checking every label against its
picture (npm runs it first), so the model sees the labels exactly as saved. Each round starts again
from the same weights (BASE), and is kept in data/model/round-N: its weights, how training went, and
the pages it learned from.

A trial round holds whole series back (HOLDOUT), so no page of a chapter it's judged on is one it
learned from, and judges each epoch on them: it stops once they stop getting better (PATIENCE) and
keeps the epoch that did best on them. score.py then measures it on both sides; a big gap between
them means the round learned its pages by heart. The round kept for the labeller and the app learns
from every page (PANELS_HOLDOUT=0) for as many epochs as the trials found best (PANELS_EPOCHS), and
keeps its last epoch, since there's nothing left to judge it on.

The model finds each panel's box and its four corners, in the order they're labelled, so a slanted
panel comes back slanted. Its corners are the answer: nothing after it squares them off or moves them.
"""

import json
import math
import os
import random
import re
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path

import cv2
import numpy as np
import torch
import ultralytics
import ultralytics.utils.loss
from ultralytics import YOLO

import guess
from pages import DATA, DEVICE, MODELS, SIZE, windows, write

# The pictures cut and listed the way YOLO reads them, in the container or the Mac's /tmp.
WORK = Path("/tmp/yolo")
# The weights each round starts from: YOLO's trained on photos, or a kept round's (PANELS_BASE=round-6)
# when the pages that round learned from aren't here to be learned from again.
BASE = os.environ.get("PANELS_BASE", "yolo11s-pose.pt")
EPOCHS = int(os.environ.get("PANELS_EPOCHS", "300"))
# The share of series a trial round holds back, picked by SEED so every trial holds back the same.
# 0 learns from every page.
HOLDOUT = float(os.environ.get("PANELS_HOLDOUT", "0.15"))
SEED = 8
# Epochs without a better score on the held-back pages before a trial round stops.
PATIENCE = int(os.environ.get("PANELS_PATIENCE", "50"))
# How a round learns (PANELS_SETTINGS), the tuned way or YOLO's own:
# - whole: the last epochs see whole pages as labelled, never pieces of four stitched together
#   (YOLO's mosaic), so the model ends on pages as the reader shows them.
# - corners: how much the corners count, against the box and how sure it is of a panel. Tuned is twice YOLO's own,
#   since the corners are what's drawn, and a box only holds them.
# - scale: zoomed in or out by up to this much. Tuned is a third, not YOLO's half: pages come at
#   much the same size.
SETTINGS = {
    "tuned": {"whole": 40, "corners": 24.0, "scale": 0.3},
    "yolo": {"whole": 10, "corners": 12.0, "scale": 0.5},
}
CHOSEN = os.environ.get("PANELS_SETTINGS", "tuned")
# A panel cut down to less than this, in pixels, by a strip's window isn't one in that window.
LEAST = 8
# What YOLO learns: one class, a panel, of any shape.
NAMES = {0: "panel"}
# How far off a corner YOLO forgives, as a share of its panel's size (its OKS sigma), in learning and
# in judging each epoch. Its own for four corners is a quarter, which on a big panel lets a corner be
# hundreds of pixels off before it counts: the box came out a few pixels off and the corners tens.
# 0.035 came out best on the held-back pages (round 11: 8 pixels off, against 23 at a twentieth).
# Much tighter (a fiftieth) and a corner a little off counts the same as one across the page, so the
# model never learns where they go.
SIGMA = float(os.environ.get("PANELS_SIGMA", "0.035"))
# That tolerance gives up on a corner far off: past a tenth or so of its panel, it counts the same
# however far, so nothing pulls it in, and a slanted panel's corners stay on its box's. So each
# corner is also pulled in by how far off it is, as a share of its panel's size (PANELS_REACH, how
# much that counts, against the tolerance's most), the same pull near or far. 0 is YOLO's own loss.
# At 1 (round 13) the corners came out three times further off than with none (round 11), so it's
# off unless asked for.
REACH = float(os.environ.get("PANELS_REACH", "0"))
# A round that goes on from a kept one (PANELS_BASE=round-11) learns gently (PANELS_LR, YOLO's own is
# 0.002) and from the first step, so it stays close to where it started: rounds gone on from the same
# one can then be blended weight by weight. Rounds trained apart from scratch can't: halfway between
# rounds 11 and 13 found no panel at all. PANELS_TRAIN_SEED makes such rounds differ in the pictures'
# order and changes.
LR = os.environ.get("PANELS_LR")
TRAIN_SEED = int(os.environ.get("PANELS_TRAIN_SEED", "0"))


# Few pages have big slanted panels, so the model draws them as boxes. So pictures can also be turned
# (PANELS_TILT) and leaned (PANELS_SKEW), each by up to that many degrees at random, with the corners
# labelled moved along: every page then shows slanted panels too. 0 for none, as rounds before 17.
TILT = float(os.environ.get("PANELS_TILT", "0"))
SKEW = float(os.environ.get("PANELS_SKEW", "0"))


# Or made ahead: the pages are learned upright as they are, and on top of them a share of them
# (PANELS_TILTED) again, turned and leaned at random by up to BENT degrees each way, and the pages with
# a big slanted panel (SLANTED) once more for each of PANELS_SLANTED. 0 for none.
TILTED = float(os.environ.get("PANELS_TILTED", "0"))
SLANTED_COPIES = int(os.environ.get("PANELS_SLANTED", "0"))
BENT = 5.0
# A slanted panel: one side leaning more than this many degrees off straight...
LEANS = 3.0
# ...on a panel at least this share of its picture.
BIG = 0.05
# The pages a round misses panels on (data/hard.json, written by hard.py), learned once more for each of
# PANELS_HARD: 2 learns them three times as often. 0 for none.
HARD_COPIES = int(os.environ.get("PANELS_HARD", "0"))


def hard_pages(copies=HARD_COPIES):
    """The pages to learn again, if asked: those data/hard.json lists."""
    if not copies:
        return set()
    f = DATA / "hard.json"
    if not f.exists():
        sys.exit("No data/hard.json: run hard.py with a round first.")
    return set(json.loads(f.read_text("utf8"))["pages"])


def slanted(quad, w, h):
    """Whether a panel is big and has a side leaning off straight."""
    area = 0.5 * abs(sum(quad[k][0] * quad[(k + 1) % 4][1] - quad[(k + 1) % 4][0] * quad[k][1] for k in range(4)))
    if area < BIG * w * h:
        return False
    for k in range(4):
        dx, dy = abs(quad[(k + 1) % 4][0] - quad[k][0]), abs(quad[(k + 1) % 4][1] - quad[k][1])
        a = math.degrees(math.atan2(dy, dx))
        if min(a, 90 - a) > LEANS:
            return True
    return False


def bent(picture, quads, turn, lean):
    """
    A picture turned by `turn` degrees and leaned by `lean` about its middle, the same size, the
    corner left grey as YOLO does; and its panels' corners moved along, kept on the picture.
    """
    h, w = picture.shape[:2]
    m = cv2.getRotationMatrix2D((w / 2, h / 2), turn, 1.0)
    m = np.vstack([m, [0, 0, 1]])
    s = np.array([[1, math.tan(math.radians(lean)), -math.tan(math.radians(lean)) * h / 2], [0, 1, 0], [0, 0, 1]])
    m = (s @ m)[:2]
    out = cv2.warpAffine(picture, m, (w, h), borderValue=(114, 114, 114))
    moved = [[(min(max(m[0, 0] * x + m[0, 1] * y + m[0, 2], 0), w), min(max(m[1, 0] * x + m[1, 1] * y + m[1, 2], 0), h)) for x, y in q] for q in quads]
    return out, moved


def bending(tilt=TILT, skew=SKEW):
    """How far YOLO may turn and lean each picture as it learns, in degrees either way."""
    return {"degrees": tilt, "shear": skew}


def learning(lr=LR):
    """What YOLO's training is told on top of the rest: how fast it learns, if not its own way."""
    if not lr:
        return {}
    return {"optimizer": "AdamW", "lr0": float(lr), "warmup_epochs": 0}


def reaching(self, pred_kpts, gt_kpts, kpt_mask, area):
    """YOLO's corner loss (KeypointLoss.forward), and a pull on each corner by how far off it is."""
    d = (pred_kpts[..., 0] - gt_kpts[..., 0]).pow(2) + (pred_kpts[..., 1] - gt_kpts[..., 1]).pow(2)
    kpt_loss_factor = kpt_mask.shape[1] / (torch.sum(kpt_mask != 0, dim=1) + 1e-9)
    e = d / ((2 * self.sigmas).pow(2) * (area + 1e-9) * 2)
    # How far off, as a share of the panel's size: the tiny add keeps it smooth at none off.
    far = (d + 1e-9).sqrt() / (area + 1e-9).sqrt()
    return (kpt_loss_factor.view(-1, 1) * ((1 - torch.exp(-e) + REACH * far) * kpt_mask)).mean()


def series_of(page):
    """The series a page is from: its name up to the chapter, a colour edition the same series as its ink one."""
    m = re.match(r"^(.+?)(?:color)?-c[^-]+-p\d+$", page)
    return m.group(1) if m else page


def split(rows, share=HOLDOUT, seed=SEED):
    """
    The rows learned from, the rows held back, and the series held back: `share` of every series
    (at least one, if any), picked at random by `seed`, each series wholly on one side.
    """
    every = sorted({series_of(r["page"]) for r in rows})
    if share <= 0 or not every:
        return rows, [], []
    rng = random.Random(seed)
    held = sorted(rng.sample(every, max(1, round(share * len(every)))))
    out = set(held)
    return [r for r in rows if series_of(r["page"]) not in out], [r for r in rows if series_of(r["page"]) in out], held


def lines():
    f = DATA / "dataset.jsonl"
    if not f.exists():
        sys.exit("No data/dataset.jsonl: run npm --prefix ai run panels-export first.")
    return [json.loads(l) for l in f.read_text("utf8").splitlines() if l]


def yolo_line(quad, top, w, h):
    """A panel in a window from `top`, as a line of YOLO's: its class, its box, then its corners, all 0 to 1."""
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


def dataset(train, held=()):
    """
    Writes the pages out for YOLO, a strip a window at a time: those learned from in train, those
    held back in val. Says how many pictures each.
    """
    shutil.rmtree(WORK, ignore_errors=True)
    counts = {}
    hard = hard_pages(HARD_COPIES)
    for part, rows in (("train", train), ("val", held)):
        images, labels = WORK / "images" / part, WORK / "labels" / part
        images.mkdir(parents=True)
        labels.mkdir(parents=True)
        counts[part] = 0
        # Which pages are learned again turned: the same ones every time.
        rng = random.Random(SEED)

        def put(name, picture, quads, top=0):
            # Lossless, so the model learns from the picture as labelled.
            cv2.imwrite(str(images / f"{name}.png"), picture)
            found = [yolo_line(q, top, picture.shape[1], picture.shape[0]) for q in quads]
            (labels / f"{name}.txt").write_text("".join(f"{l}\n" for l in found if l))
            counts[part] += 1

        for row in rows:
            picture = cv2.imread(str(DATA / row["image"]), cv2.IMREAD_COLOR)
            if picture is None or picture.shape[:2] != (row["height"], row["width"]):
                sys.exit(f"{row['image']} doesn't read as the {row['width']}x{row['height']} picture labelled.")
            again = part == "train" and rng.random() < TILTED
            for k, (top, bottom) in enumerate(windows(row["width"], row["height"])):
                name = f"{row['page']}-{k}"
                piece = picture[top:bottom]
                put(name, piece, row["panels"], top)
                if part != "train":
                    continue
                # The window's panels as they are in it, cut by it.
                inside = [[(x, min(max(y - top, 0), bottom - top)) for x, y in q] for q in row["panels"]]
                inside = [q for q in inside if max(p[1] for p in q) - min(p[1] for p in q) >= LEAST]
                if again:
                    put(f"{name}-turned", *bent(piece, inside, rng.uniform(-BENT, BENT), rng.uniform(-BENT, BENT)))
                if any(slanted(q, piece.shape[1], piece.shape[0]) for q in inside):
                    for c in range(SLANTED_COPIES):
                        put(f"{name}-slanted-{c}", piece, inside)
                if row["page"] in hard:
                    for c in range(HARD_COPIES):
                        put(f"{name}-hard-{c}", piece, inside)
    # The corners mirror in pairs when a page is flipped: top left with top right, bottom right
    # with bottom left. Each epoch is judged on the pages held back, or, with none, on those learned
    # from, which only YOLO needs: that round keeps its last epoch, not its best.
    val = "images/val" if held else "images/train"
    (WORK / "panels.yaml").write_text(
        f"path: {WORK}\ntrain: images/train\nval: {val}\n"
        f"kpt_shape: [4, 3]\nflip_idx: [1, 0, 3, 2]\nkpt_oks_sigmas: [{', '.join([str(SIGMA)] * 4)}]\nnames:\n"
        + "".join(f"  {k}: {name}\n" for k, name in NAMES.items())
    )
    return counts


def main():
    if CHOSEN not in SETTINGS:
        sys.exit(f"PANELS_SETTINGS is {CHOSEN!r}: it's one of {', '.join(SETTINGS)}.")
    chosen = SETTINGS[CHOSEN]
    rows = lines()
    if not rows:
        sys.exit("No labelled pages yet: label a few first.")
    done = [int(p.name.split("-")[1]) for p in MODELS.glob("round-*") if p.name.split("-")[1].isdigit()]
    n = max(done, default=0) + 1
    train, held, held_series = split(rows)
    trial = bool(held)
    pictures = dataset(train, held)
    panels = sum(len(r["panels"]) for r in train)
    print(f"Round {n}: learns from {len(train)} pages, {panels} panels, as {pictures['train']} pictures.", flush=True)
    if trial:
        print(f"Held back to judge it on: {len(held)} pages ({pictures['val']} pictures) from {len(held_series)} series: {', '.join(held_series)}.", flush=True)
    print(f"Settings: {CHOSEN} {chosen}, up to {EPOCHS} epochs.", flush=True)

    if REACH > 0:
        ultralytics.utils.loss.KeypointLoss.forward = reaching
    print(f"Corners: tolerance {SIGMA}, pulled in from far by {REACH}.", flush=True)
    if TILT or SKEW:
        print(f"Pictures turned up to {TILT} and leaned up to {SKEW} degrees.", flush=True)
    if HARD_COPIES:
        print(f"Pages it missed panels on learned {HARD_COPIES + 1} times as often: {len(hard_pages(HARD_COPIES))} of them.", flush=True)
    if LR:
        print(f"Goes on from {BASE}, learning at {LR}, seed {TRAIN_SEED}.", flush=True)

    base = BASE
    if BASE.startswith("round-"):
        base = str(MODELS / BASE / "best.pt")
    model = YOLO(base)
    model.train(
        data=str(WORK / "panels.yaml"),
        epochs=EPOCHS,
        # A trial stops once the held-back pages stop getting better; a round with none runs every epoch.
        patience=PATIENCE if trial else EPOCHS,
        imgsz=SIZE,
        batch=8,
        device=DEVICE,
        workers=4,
        project="/tmp/runs",
        name="round",
        exist_ok=True,
        seed=TRAIN_SEED,
        plots=False,
        # Pages are drawn upright, so they're flipped across, never upside down; turned only a little, if asked.
        fliplr=0.5,
        flipud=0.0,
        **bending(),
        scale=chosen["scale"],
        close_mosaic=chosen["whole"],
        pose=chosen["corners"],
        **learning(),
    )
    run = Path(model.trainer.save_dir)

    out = MODELS / f"round-{n}"
    out.mkdir(parents=True, exist_ok=True)
    # A trial keeps its best epoch on the held-back pages; a round with none, its last.
    kept = model.trainer.best if trial else model.trainer.last
    shutil.copy(kept, out / "best.pt")
    ran = 0
    if (run / "results.csv").exists():
        shutil.copy(run / "results.csv", out / "results.csv")
        ran = len((run / "results.csv").read_text("utf8").strip().splitlines()) - 1
    # The epoch kept, counted from 1: a trial's best on the held-back pages, as YOLO's early stopping
    # saw it (the weights kept no longer say, once YOLO strips them), or the last one run.
    kept_epoch = model.trainer.stopper.best_epoch if trial else ran
    write(
        out / "round.json",
        {
            "round": n,
            "made": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "base": BASE,
            "ultralytics": ultralytics.__version__,
            "size": SIZE,
            "epochs": EPOCHS,
            "ran": ran,
            "kept epoch": kept_epoch,
            "patience": PATIENCE if trial else None,
            "settings": CHOSEN,
            **chosen,
            "held out": {"share": HOLDOUT, "seed": SEED, "series": held_series, "pages": [r["page"] for r in held]},
            "panels": panels,
            "names": NAMES,
            "sigma": SIGMA,
            "reach": REACH,
            "lr": float(LR) if LR else None,
            "train seed": TRAIN_SEED,
            "tilt": TILT,
            "skew": SKEW,
            "tilted": TILTED,
            "slanted copies": SLANTED_COPIES,
            "hard copies": HARD_COPIES,
            "hard pages": sorted(hard_pages(HARD_COPIES)),
            "pages": [r["page"] for r in train],
        },
    )
    print(f"Round {n} kept in data/model/round-{n}: epoch {kept_epoch} of {ran} run.", flush=True)
    if trial:
        # A trial is for score.py, never for the labeller: the latest round and its guesses stay.
        print(f"A trial: score it with PANELS_ROUND={n} npm --prefix ai run panels-score.", flush=True)
        return
    write(MODELS / "latest.json", {"round": n})
    guess.main()


if __name__ == "__main__":
    main()
