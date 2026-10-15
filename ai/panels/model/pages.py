"""
What the trainer and the guesser share (README.md): where the data is, the pages of every set, and
the windows a webtoon's strip is cut into, since a strip squeezed whole into the model's square
would leave its panels a few pixels wide.
"""

import json
import os
from pathlib import Path

DATA = Path(os.environ.get("PANELS_DATA", "/data"))
# The GPU: the first CUDA card in Docker, or "mps" on a Mac (mac.sh).
DEVICE = os.environ.get("PANELS_DEVICE", "0")
MODELS = DATA / "model"
GUESSES = DATA / "guesses"
# The side of the square the model sees a picture in, in pixels.
SIZE = 1024
# A picture this many times taller than it's wide is a strip (the labeller's TALLEST), looked at a
# window at a time, each as tall as this many widths.
TALLEST = 2


def pages():
    """
    Every set's pages, in order: data/pages.json, then pages2.json, and on. A set not fetched here
    is skipped, so the later ones still count on a machine that only has those (labels.ts setsIn).
    """
    sets = []
    for f in DATA.glob("pages*.json"):
        number = f.stem.removeprefix("pages")
        if number == "":
            sets.append((1, f))
        elif number.isdigit():
            sets.append((int(number), f))
    out = []
    for _, f in sorted(sets):
        out += json.loads(f.read_text("utf8"))
    return out


def windows(width, height):
    """
    The rows of a picture the model looks at, as (top, bottom): all of it, or a strip's windows.
    They overlap by half, so a panel no taller than the strip is wide is whole in one of them.
    """
    if height <= width * TALLEST:
        return [(0, height)]
    tall = width * TALLEST
    tops = list(range(0, height - tall, tall // 2)) + [height - tall]
    return [(t, t + tall) for t in tops]


def write(path, value):
    """Writes JSON whole or not at all: to a file beside it first, then moved into place."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(value, indent=1) + "\n", "utf8")
    os.replace(tmp, path)
