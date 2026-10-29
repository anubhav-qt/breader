"""
Guesses the panels on every page not labelled yet with the latest round of the model (README.md),
into data/guesses/<page>.json, for the labeller to start from instead of Breader's own finder. A
guess is only a start: what's saved is what's on screen once it's fixed.

A strip is looked at a window at a time (pages.windows), and its windows' panels joined back up.
Panels come out in the order they're read: rows top to bottom, and across them right to left,
with gutters that can slant.
"""

import json
import math
import sys
from datetime import datetime, timezone

import cv2
from ultralytics import YOLO

from pages import DATA, DEVICE, GUESSES, MODELS, SIZE, pages, windows, write

# How sure the model has to be of a panel to guess it.
SURE = 0.3
# A panel this close to a window's cut, in pixels, may be cut by it.
NEAR = 4
# How sure the model has to be of a corner to take it wherever it puts it.
CORNER = 0.5
# A corner it's less sure of is taken this close to its panel's box, as a share of the box's shorter
# side: a corner on the page's edge is always one, as it learned those as out of sight (training
# crops pages), though it puts them where they are.
ON_BOX = 0.1


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
    A panel's corners as guessed, in whole pixels on the page: where the model puts them, but its
    box's for one it's unsure of away from the box, all four when it's sure of none, and when they
    don't make a sensible panel. The same as the app's (shared/src/panels.ts).
    """
    whole = lambda x, y: [int(min(max(round(x), 0), w)), int(min(max(round(y), 0), h))]
    square = [whole(x, y) for x, y in corners_of(box)]
    if all(sure < CORNER for _, _, sure in points):
        return square
    near = ON_BOX * min(box[2] - box[0], box[3] - box[1])
    on_box = lambda x, y: min(abs(x - box[0]), abs(x - box[2]), abs(y - box[1]), abs(y - box[3])) <= near
    q = [whole(x, y) if sure >= CORNER or on_box(x, y) else square[i] for i, (x, y, sure) in enumerate(points)]
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


# How far a panel may reach past the gutter into the next row or column, as a share of the smaller
# one's height (or width): the model's corners are a few pixels off, more so on bigger panels.
SLACK = 0.1
# The steepest a gutter between rows or columns is looked for, in degrees either way of straight.
STEEPEST = 20
# Two panels side by side, their heights overlapping by this share of the shorter's, are one row;
# stacked, widths, one column.
BESIDE = 0.5
# Straight first, then a degree more either way at a time.
ANGLES = [0] + [d for i in range(1, STEEPEST + 1) for d in (i, -i)]


def span_of(q, ux, uy):
    """How far along (ux, uy) a panel's corners reach, least and most."""
    v = [x * ux + y * uy for x, y in q]
    return (min(v), max(v))


def mid(s):
    return (s[0] + s[1]) / 2


def beside(a, b):
    return min(a[1], b[1]) - max(a[0], b[0]) > BESIDE * min(a[1] - a[0], b[1] - b[0])


def ordered(found):
    """
    The panels the page is read in: cut into rows top to bottom, and across them right to left, by
    their corners, so a gutter can slant. What can't be cut is read a panel at a time, each beside
    another after the one to its right, and each below another after it (before). The same as the
    app's (shared/src/panels.ts).
    """

    def split(items, across):
        """
        The first row of items (or right column, across) and the rest, split by a gutter as straight
        as there is: every panel of the first ends before every one of the rest begins, give or take
        SLACK. Two on either side of the gutter, neither across it from the other, mustn't sit beside
        each other (or one above the other, across): that's a gutter through a row (or a column).
        """
        side = [span_of(f["quad"], 1, 0) if across else span_of(f["quad"], 0, 1) for f in items]
        for deg in ANGLES:
            t = deg * math.pi / 180
            c, n = math.cos(t), math.sin(t)
            # How far down the page square to a row's gutter (or right, square to a column's), and how far along it.
            s = [span_of(f["quad"], c, n) if across else span_of(f["quad"], -n, c) for f in items]
            along = [span_of(f["quad"], -n, c) if across else span_of(f["quad"], c, n) for f in items]
            order = sorted(range(len(items)), key=lambda i: -mid(s[i]) if across else mid(s[i]))
            for k in range(1, len(order)):
                first, rest = order[:k], order[k:]
                if all(
                    (s[j][1] - s[i][0] if across else s[i][1] - s[j][0]) <= SLACK * min(s[i][1] - s[i][0], s[j][1] - s[j][0])
                    and (min(along[i][1], along[j][1]) > max(along[i][0], along[j][0]) or not beside(side[i], side[j]))
                    for i in first
                    for j in rest
                ):
                    return [items[i] for i in first], [items[i] for i in rest]
        return None

    def cut(items):
        if len(items) < 2:
            return items
        parts = split(items, False) or split(items, True)
        if parts:
            return cut(parts[0]) + cut(parts[1])
        ys = [span_of(f["quad"], 0, 1) for f in items]
        xs = [span_of(f["quad"], 1, 0) for f in items]
        at = [(sum(c[0] for c in f["quad"]) / len(f["quad"]), sum(c[1] for c in f["quad"]) / len(f["quad"])) for f in items]

        def before(a, b):
            """Of two beside each other the right one is read first, of two stacked the upper, and otherwise whichever way they're further apart says."""
            side_by_side = beside(ys[a], ys[b])
            stacked = beside(xs[a], xs[b])
            across = abs(at[a][0] - at[b][0]) > abs(at[a][1] - at[b][1]) if side_by_side == stacked else side_by_side
            return at[a][0] > at[b][0] if across else at[a][1] < at[b][1]

        # Each once none left is read before it; of those that go round, the topmost.
        left = sorted(range(len(items)), key=lambda i: at[i][1])
        out = []
        while left:
            k = next((k for k, a in enumerate(left) if not any(b != a and before(b, a) for b in left)), 0)
            out.append(items[left.pop(k)])
        return out

    return cut(found)


def guess(model, picture, w, h):
    found = []
    spans = windows(w, h)
    for k, (top, bottom) in enumerate(spans):
        r = model.predict(picture[top:bottom], imgsz=SIZE, conf=SURE, device=DEVICE, verbose=False)[0]
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
    return ordered(found)


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
