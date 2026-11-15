"""
Checks a round of the panel model against the owner's thumbs (README.md, The owner's votes): the
panels liked while reading have to come out where they were, and the ones disliked have to come out
somewhere else. Labels say how well a round fits pages it learned from; the votes are on pages it
has never seen, as readers get them.

    PANELS_ROUND=22 python votes.py     a given round, or the latest without it

Reads data/votes/votes.json (the export of panel_votes, with each page's picture address), fetches
each picture once into data/votes/pages/, guesses every voted page the way guess.py does, and writes
data/model/round-N/votes.json and, for every page with a vote that didn't hold, a picture in
data/votes/round-N/: the votes on the left, this round's panels on the right.
"""

import hashlib
import json
import os
import sys
import urllib.request

from pages import DATA, MODELS, write

VOTES = DATA / "votes"
# A voted panel is this round's guess that overlaps it most, if they overlap at least this much.
SAME = 0.5
# A panel came out where it was if every corner is within this share of the page's longer side:
# a hundredth, 20 pixels on a page 2000 tall. The corners the owner disliked were 50 off.
CLOSE = 0.01


def box_of(q):
    xs, ys = [p[0] for p in q], [p[1] for p in q]
    return (min(xs), min(ys), max(xs), max(ys))


def iou(a, b):
    w = min(a[2], b[2]) - max(a[0], b[0])
    h = min(a[3], b[3]) - max(a[1], b[1])
    both = max(0, w) * max(0, h)
    return both / (((a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - both) or 1)


def moved(a, b):
    """How far the furthest corner of panel a is from the same corner of b, in pixels."""
    return max(((p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2) ** 0.5 for p, q in zip(a, b))


def on_page(quad, vw, vh, w, h):
    """A vote's corners, given in the pixels of a picture vw by vh, on the page as it is here, w by h."""
    if (vw, vh) == (w, h):
        return [list(p) for p in quad]
    return [[x * w / vw, y * h / vh] for x, y in quad]


def judge(quad, guessed, w, h):
    """
    What became of a voted panel among this round's guesses: "same" (every corner within CLOSE),
    "moved" (the panel's there, a corner isn't) or "gone" (no guess over it); and how far it moved.
    """
    best = max(guessed, key=lambda g: iou(box_of(quad), box_of(g)), default=None)
    if best is None or iou(box_of(quad), box_of(best)) < SAME:
        return "gone", None
    far = moved(quad, best)
    return ("same" if far <= CLOSE * max(w, h) else "moved"), far


def held(good, what):
    """Whether a vote held: a liked panel is the same, a disliked one isn't."""
    return (what == "same") == good


def summary(rows):
    """What the votes add up to, from each one's {"good", "what"}."""
    likes = [r for r in rows if r["good"]]
    dislikes = [r for r in rows if not r["good"]]

    def pct(n, of):
        return round(100 * n / of, 1) if of else 0.0

    def count(some, what):
        return sum(r["what"] == what for r in some)

    return {
        "votes": len(rows),
        "likes": len(likes),
        "likes the same %": pct(count(likes, "same"), len(likes)),
        "likes moved": count(likes, "moved"),
        "likes gone": count(likes, "gone"),
        "dislikes": len(dislikes),
        "dislikes changed %": pct(len(dislikes) - count(dislikes, "same"), len(dislikes)),
        "dislikes moved": count(dislikes, "moved"),
        "dislikes gone": count(dislikes, "gone"),
        "dislikes the same": count(dislikes, "same"),
    }


def by_page(votes):
    """The votes of each page, by (chapter, n), in the export's order."""
    out = {}
    for v in votes:
        out.setdefault((v["chapter"], v["n"]), []).append(v)
    return out


def file_of(page):
    """Where a voted page's picture is kept: named by its chapter and number, hashed."""
    name = hashlib.sha256(f"{page['chapter']}\n{page['n']}".encode()).hexdigest()[:16]
    return VOTES / "pages" / f"{name}.img"


def picture_of(page):
    """A voted page's picture as OpenCV reads it, fetched from Breader once. None if it can't be had."""
    import cv2
    import numpy as np

    f = file_of(page)
    if not f.exists():
        if not page.get("url"):
            return None
        f.parent.mkdir(parents=True, exist_ok=True)
        try:
            req = urllib.request.Request(page["url"], headers={"User-Agent": "breader-panels"})
            data = urllib.request.urlopen(req, timeout=60).read()
        except OSError as e:
            print(f"{page['url']}: {e}")
            return None
        f.write_bytes(data)
    return cv2.imdecode(np.frombuffer(f.read_bytes(), np.uint8), cv2.IMREAD_COLOR)


def drawn(picture, before, after):
    """The page twice, side by side: its votes (liked green, disliked red), and this round's panels (purple)."""
    import cv2
    import numpy as np

    def over(quads):
        out = picture.copy()
        wide = max(3, round(max(picture.shape[:2]) / 250))
        for q, colour in quads:
            cv2.polylines(out, [np.array(q, np.int32).reshape(-1, 1, 2)], True, colour, wide, cv2.LINE_AA)
        return out

    left = over([(q, (0, 170, 0) if good else (0, 0, 230)) for q, good in before])
    right = over([(q, (200, 0, 160)) for q in after])
    both = np.hstack([left, np.full((picture.shape[0], 20, 3), 255, np.uint8), right])
    scale = 1400 / both.shape[1]
    return cv2.resize(both, (1400, round(both.shape[0] * scale)), interpolation=cv2.INTER_AREA) if scale < 1 else both


def main():
    import cv2
    from ultralytics import YOLO

    from guess import guess, margin_of

    f = VOTES / "votes.json"
    if not f.exists():
        sys.exit("No data/votes/votes.json: export the owner's votes first (README.md, The owner's votes).")
    export = json.loads(f.read_text("utf8"))
    asked = os.environ.get("PANELS_ROUND")
    n = int(asked) if asked else json.loads((MODELS / "latest.json").read_text("utf8"))["round"]
    model = YOLO(str(MODELS / f"round-{n}" / "best.pt"))
    votes = by_page(export["votes"])
    rows, unread, shown = [], 0, 0
    for k, page in enumerate(export["pages"]):
        mine = votes.get((page["chapter"], page["n"]), [])
        picture = picture_of(page) if mine else None
        if picture is None:
            unread += bool(mine)
            continue
        h, w = picture.shape[:2]
        guessed = [g["quad"] for g in guess(model, picture, w, h, margin_of(n))]
        before, broke = [], False
        for v in mine:
            quad = on_page(v["quad"], v["w"], v["h"], w, h)
            what, far = judge(quad, guessed, w, h)
            rows.append({"page": k, "title": page.get("title"), "good": v["good"], "what": what, "moved px": None if far is None else round(far, 1)})
            before.append((quad, v["good"]))
            broke = broke or not held(v["good"], what)
        if broke:
            out = VOTES / f"round-{n}" / f"{k:04d}.jpg"
            out.parent.mkdir(parents=True, exist_ok=True)
            cv2.imwrite(str(out), drawn(picture, before, guessed))
            shown += 1
    result = {
        "round": n,
        "margin": margin_of(n),
        "exported": export.get("exportedAt"),
        **summary(rows),
        "pages not read": unread,
        "pages to look at": shown,
        "votes that didn't hold": [r for r in rows if not held(r["good"], r["what"])],
    }
    write(MODELS / f"round-{n}" / "votes.json", result)
    print(json.dumps({k: v for k, v in result.items() if k != "votes that didn't hold"}, indent=1))
    if shown:
        print(f"Look at data/votes/round-{n}/: {shown} pages with a vote that didn't hold.")


if __name__ == "__main__":
    main()
