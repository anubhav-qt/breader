"""
Watches the panel model train, live in a terminal (README.md), on this machine, not in Docker:

    npm --prefix ai run panels-watch

Shows only what matters: how far along a round is, a chart of how well it finds panels on pages it
never learned from, and one line saying whether that's still getting better, has stopped, or is
getting worse (learning its pages by heart). A run started later is picked up by itself. With none
running, it shows each round's result as a bar. Python's standard library only. Ctrl+C stops it.
"""

import csv
import io
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

MODELS = Path(os.environ.get("PANELS_DATA", Path(__file__).resolve().parent.parent / "data")) / "model"
RUN = "/tmp/runs/round"
EVERY = float(os.environ.get("PANELS_WATCH_EVERY", "5"))
NAME = "breader-panels-train"
EIGHTHS = " ▁▂▃▄▅▆▇█"
HEIGHT = 8
# What's charted: how well it finds the corners, YOLO's pose mAP50-95, shown as a percent.
SCORE = "metrics/mAP50-95(P)"

GREEN, YELLOW, RED, DIM, BOLD, OFF = "\x1b[32m", "\x1b[33m", "\x1b[31m", "\x1b[2m", "\x1b[1m", "\x1b[0m"


def sh(*args):
    """A command's output, or None if it failed."""
    try:
        r = subprocess.run(args, capture_output=True, text=True, encoding="utf8", errors="replace", timeout=20)
    except (OSError, subprocess.TimeoutExpired):
        return None
    return r.stdout if r.returncode == 0 else None


def running():
    """The newest training container's name, or None."""
    out = sh("docker", "ps", "--filter", f"name={NAME}", "--format", "{{.CreatedAt}}\t{{.Names}}")
    rows = sorted(l.split("\t") for l in (out or "").splitlines() if "\t" in l)
    return rows[-1][1] if rows else None


def table(text):
    """results.csv as rows of numbers by column name, headers stripped of YOLO's padding."""
    if not text or not text.strip():
        return []
    out = []
    for r in csv.DictReader(io.StringIO(text)):
        row = {}
        for k, v in r.items():
            try:
                row[k.strip()] = float(v)
            except (AttributeError, TypeError, ValueError):
                pass
        if "epoch" in row:
            out.append(row)
    return out


def args_of(text):
    """YOLO's args.yaml, its top-level lines, as a dict of strings."""
    out = {}
    for l in (text or "").splitlines():
        if ":" in l and not l.startswith(" "):
            k, v = l.split(":", 1)
            out[k.strip()] = v.strip()
    return out


def number(value):
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return None


def rounds():
    """Every kept round's number, oldest first."""
    return sorted(int(p.name.split("-")[1]) for p in MODELS.glob("round-*") if p.name.split("-")[1].isdigit())


def read_json(path):
    try:
        return json.loads(path.read_text("utf8"))
    except (OSError, ValueError):
        return None


def bar(done, total, width):
    """A progress bar."""
    full = round(width * min(1, done / total)) if total else 0
    return f"{GREEN}{'━' * full}{OFF}{DIM}{'─' * (width - full)}{OFF}"


def chart(values, width):
    """A chart of values (0 to 1) over the epochs, as lines of text, its scale fitted to them."""
    if len(values) > width:
        cuts = [round(i * len(values) / width) for i in range(width + 1)]
        values = [sum(values[a:b]) / (b - a) for a, b in zip(cuts, cuts[1:]) if b > a]
    # The first epochs start far off and would squash the rest flat, so the scale leaves them out.
    ref = values[2:] if len(values) > 8 else values
    lo, hi = min(ref), max(ref)
    if hi - lo < 0.02:
        lo, hi = max(0, hi - 0.02), min(1, lo + 0.02)
    steps = HEIGHT * 8
    levels = [max(1, min(steps, round((v - lo) / (hi - lo) * (steps - 1)) + 1)) for v in values]
    lines = []
    for row in range(HEIGHT - 1, -1, -1):
        cells = "".join(EIGHTHS[min(8, max(0, lv - row * 8))] for lv in levels)
        label = f"{hi * 100:3.0f}%" if row == HEIGHT - 1 else f"{lo * 100:3.0f}%" if row == 0 else "    "
        lines.append(f"  {DIM}{label} │{OFF}{GREEN}{cells}{OFF}")
    return lines


def live(name, width):
    rows = table(sh("docker", "exec", name, "cat", f"{RUN}/results.csv"))
    args = args_of(sh("docker", "exec", name, "cat", f"{RUN}/args.yaml"))
    split = (sh("docker", "exec", name, "sh", "-c", "grep -c '^val: images/val' /tmp/yolo/panels.yaml || true") or "").strip()
    held = split == "1"
    n = max(rounds(), default=0) + 1
    out = [f"  {BOLD}Round {n}{OFF} is training", ""]
    total = number(args.get("epochs"))
    if not rows:
        return out + ["  Getting the pages ready..."]

    epoch = int(rows[-1]["epoch"])
    times = [r.get("time", 0) for r in rows[-6:]]
    each = (times[-1] - times[0]) / (len(times) - 1) if len(times) > 1 else times[0]
    scores = [r.get(SCORE, 0) for r in rows]
    best = max(range(len(rows)), key=lambda i: scores[i])
    since = epoch - int(rows[best]["epoch"])
    patience = number(args.get("patience"))
    stops = held and patience and total and patience < total
    left = (total or epoch) - epoch
    if stops:
        left = min(left, patience - since)
    at_most = "at most " if stops else "about "
    w = max(20, min(60, width - 30))
    out.append(f"  {bar(epoch, total or epoch, w)}  epoch {epoch} of {total}, {at_most}{max(0, left) * each / 60:.0f} min left")
    out.append("")
    out.append(f"  How well it finds panels on {'pages it never learned from' if held else 'the pages it learns from'}")
    out += chart(scores, w)
    # The epochs under the chart, first and last, as wide as it's drawn.
    drawn = min(w, len(scores))
    last = f"{' ' * max(1, drawn - 1 - len(str(epoch)))}{epoch}" if epoch > 1 else ""
    out.append(f"  {DIM}       1{last}  epoch{OFF}")
    out.append("")

    # Slipping on new pages for a while after its best, while it keeps learning its own, is learning
    # them by heart: the last few epochs' average 3 points or more under the best.
    recent = scores[-5:]
    worse = held and since >= 15 and sum(recent) / len(recent) <= scores[best] - 0.03
    if not held:
        out.append(f"  {DIM}No pages held back this round, so it can't show learning by heart.{OFF}")
    elif worse:
        out.append(f"  {RED}Slipping on new pages since epoch {int(rows[best]['epoch'])}{OFF}: it's starting to learn its own pages by heart.")
    elif since == 0 or since < 5:
        out.append(f"  {GREEN}Still getting better.{OFF} Best so far: {scores[best] * 100:.0f}%.")
    else:
        stop = f" Stops after {patience - since} more." if stops else ""
        out.append(f"  {YELLOW}No better for {since} epochs{OFF} (best {scores[best] * 100:.0f}%, epoch {int(rows[best]['epoch'])}).{stop}")
    return out


def results(width):
    """Each scored round as a bar: how far off its corners are on new pages. Shorter is better."""
    scored = []
    for n in rounds():
        s = read_json(MODELS / f"round-{n}" / "score.json") or {}
        px = (s.get("never seen") or {}).get("all", {}).get("worst corner px, median")
        if px is not None:
            scored.append((n, px))
    if not scored:
        return []
    top = max(px for _, px in scored[-8:]) or 1
    w = max(10, min(40, width - 30))
    out = ["  How far off each round is on new pages (shorter is better)", ""]
    for n, px in scored[-8:]:
        full = max(1, round(w * px / top))
        out.append(f"  Round {n:<3} {GREEN}{'█' * full}{OFF} {px:.0f} px off")
    return out


def frame():
    width = shutil.get_terminal_size((80, 30)).columns
    name = running()
    out = [""]
    if name:
        out += live(name, width)
    else:
        out += [f"  {DIM}Nothing training now. A new round shows here by itself.{OFF}", ""]
        out += results(width)
    out += ["", f"  {DIM}Ctrl+C to stop watching{OFF}"]
    return "\n".join(out)


def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except AttributeError:
        pass
    once = "--once" in sys.argv
    try:
        while True:
            text = frame()
            sys.stdout.write(text + "\n" if once else "\x1b[H\x1b[2J" + text + "\n")
            sys.stdout.flush()
            if once:
                return
            time.sleep(EVERY)
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
