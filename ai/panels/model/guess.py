"""
Guesses the panels on every page not labelled yet with the latest round of the model (README.md),
into data/guesses/<page>.json, for the labeller to start from instead of Breader's own finder. A
guess is only a start: what's saved is what's on screen once it's fixed.

A strip is looked at a window at a time (pages.windows), and its windows' panels joined back up.
Panels come out in the order they're read: rows top to bottom, and across them right to left.
"""

import json
import sys
from datetime import datetime, timezone

import cv2
from ultralytics import YOLO

from pages import DATA, GUESSES, MODELS, SIZE, pages, windows, write

# How sure the model has to be of a panel to guess it.
SURE = 0.3
# A panel this close to a window's cut, in pixels, may be cut by it.
NEAR = 4


def area(b):
    return max(0, b[2] - b[0]) * max(0, b[3] - b[1])


def overlap(a, b):
    return area((max(a[0], b[0]), max(a[1], b[1]), min(a[2], b[2]), min(a[3], b[3])))


def iou(a, b):
    both = overlap(a, b)
    return both / ((area(a) + area(b) - both) or 1)


def corners_of(box):
    x0, y0, x1, y1 = box
    return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]


def sensible(q):
    """Whether four corners make a panel: they turn the same way all round, and enclose something."""
    turns = []
    for i in range(4):
        (ax, ay), (bx, by), (cx, cy) = q[i], q[(i + 1) % 4], q[(i + 2) % 4]
        turns.append((bx - ax) * (cy - by) - (by - ay) * (cx - bx))
    return all(t > 0 for t in turns) or all(t < 0 for t in turns)


def shoelace(q):
    return abs(sum(q[i][0] * q[(i + 1) % 4][1] - q[(i + 1) % 4][0] * q[i][1] for i in range(4))) / 2


def quad_of(points, box, w, h):
    """
    A panel's corners as guessed, in whole pixels on the page. A corner the model isn't sure of is
    its box's, and all four are when they don't make a sensible panel.
    """
    whole = lambda x, y: [int(min(max(round(x), 0), w)), int(min(max(round(y), 0), h))]
    square = [whole(x, y) for x, y in corners_of(box)]
    q = [whole(x, y) if sure >= 0.5 else square[i] for i, (x, y, sure) in enumerate(points)]
    if not sensible(q) or shoelace(q) < 0.6 * area(box):
        return square
    return q


def merged(found):
    """A strip's panels from its windows, each once: whole ones first, then pieces a cut left."""
    kept = []
    for f in sorted((f for f in found if not f["cut"]), key=lambda f: -f["sure"]):
        if all(iou(f["box"], k["box"]) < 0.5 for k in kept):
            kept.append(f)
    pieces = [f for f in found if f["cut"] and not any(overlap(f["box"], k["box"]) >= 0.7 * area(f["box"]) for k in kept)]
    joined = []
    for f in sorted(pieces, key=lambda f: f["box"][1]):
        a = f["box"]
        for j in joined:
            b = j["box"]
            across = min(a[2], b[2]) - max(a[0], b[0])
            if across >= 0.5 * min(a[2] - a[0], b[2] - b[0]) and min(a[3], b[3]) > max(a[1], b[1]):
                j["box"] = (min(a[0], b[0]), min(a[1], b[1]), max(a[2], b[2]), max(a[3], b[3]))
                j["quad"] = corners_of(j["box"])
                j["sure"] = max(j["sure"], f["sure"])
                break
        else:
            joined.append(dict(f))
    return kept + joined


def ordered(found, w, h):
    """Panels in the order they're read: cut into rows top to bottom, then across right to left."""
    sx, sy = 0.02 * w, 0.02 * h

    def cut(items):
        if len(items) < 2:
            return items
        for y in sorted({f["box"][3] for f in items}):
            above = [f for f in items if f["box"][3] <= y + sy]
            below = [f for f in items if f["box"][3] > y + sy]
            if above and below and all(f["box"][1] >= y - sy for f in below):
                return cut(above) + cut(below)
        for x in sorted({f["box"][0] for f in items}, reverse=True):
            right = [f for f in items if f["box"][0] >= x - sx]
            left = [f for f in items if f["box"][0] < x - sx]
            if right and left and all(f["box"][2] <= x + sx for f in left):
                return cut(right) + cut(left)
        return sorted(items, key=lambda f: (f["box"][1], -f["box"][2]))

    return cut(found)


def guess(model, picture, w, h):
    found = []
    spans = windows(w, h)
    for k, (top, bottom) in enumerate(spans):
        r = model.predict(picture[top:bottom], imgsz=SIZE, conf=SURE, device=0, verbose=False)[0]
        boxes = r.boxes.xyxy.cpu().numpy()
        sure = r.boxes.conf.cpu().numpy()
        points = r.keypoints.data.cpu().numpy()
        for b, s, p in zip(boxes, sure, points):
            box = (float(b[0]), float(b[1]) + top, float(b[2]), float(b[3]) + top)
            corners = [(float(x), float(y) + top, float(c)) for x, y, c in p]
            cut = (k > 0 and box[1] <= top + NEAR) or (k < len(spans) - 1 and box[3] >= bottom - NEAR)
            found.append({"box": box, "quad": quad_of(corners, box, w, h), "sure": float(s), "cut": cut})
    if len(spans) > 1:
        found = merged(found)
    return ordered(found, w, h)


def main():
    latest = MODELS / "latest.json"
    if not latest.exists():
        sys.exit("No model yet: npm --prefix ai run panels-train")
    n = json.loads(latest.read_text("utf8"))["round"]
    model = YOLO(str(MODELS / f"round-{n}" / "best.pt"))
    labelled = {f.stem for f in (DATA / "labels").glob("*.json")}
    made = datetime.now(timezone.utc).isoformat(timespec="seconds")
    count = panels = none = 0
    for page in pages():
        if page["id"] in labelled:
            continue
        picture = cv2.imread(str(DATA / "pages" / page["file"]), cv2.IMREAD_COLOR)
        if picture is None or picture.shape[:2] != (page["height"], page["width"]):
            print(f"{page['id']}: its picture doesn't read as {page['width']}x{page['height']}, not guessed.")
            continue
        found = guess(model, picture, page["width"], page["height"])
        write(
            GUESSES / f"{page['id']}.json",
            {
                "v": 1,
                "page": page["id"],
                "file": page["file"],
                "sha256": page["sha256"],
                "width": page["width"],
                "height": page["height"],
                "model": f"round-{n}",
                "made": made,
                "panels": [f["quad"] for f in found],
                "sure": [round(f["sure"], 3) for f in found],
            },
        )
        count += 1
        panels += len(found)
        none += not found
    print(f"Round {n} guessed {count} pages not labelled yet: {panels} panels, {none} pages with none.")


if __name__ == "__main__":
    main()
