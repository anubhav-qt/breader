"""
A round put live (README.md, Keeping the model): its best.pt exported to ONNX, into live.onnx here,
with live.json saying which round and the model's hash and size, for the app and the laptop to run.
live.onnx isn't kept in git: npm run ship publishes it as a release (panels-<its hash>), and every
build fetches it from there by live.json.

It takes pictures of any size, and any number at once, so the app can give it a page as the
guesser's predict does (guess.py): scaled to SIZE on its longer side, then padded only to the next
multiple of 32 (Ultralytics' letterbox for a model that takes any size), not to the square. The app
reads that from the model's input (shared/src/panels.ts, takesOf) and fits pages the same way, so
it finds what the guesser finds. Rounds before 21 were exported square, and are still read so.

    npm --prefix ai run panels-live -- 21
"""

import hashlib
import json
import os
import shutil
import sys
from pathlib import Path

from ultralytics import YOLO

from pages import MODELS, SIZE

# Where live.onnx and live.json go: this folder, mounted (compose.yml).
OUT = Path(os.environ.get("PANELS_LIVE", "/live"))


def export(best):
    """The round's model as the app runs it: raw answers out ([batch, 16 + classes, n]), no NMS in it."""
    return Path(YOLO(str(best)).export(format="onnx", imgsz=SIZE, dynamic=True, simplify=True, opset=17, end2end=False))


def check(onnx):
    """Its input takes any number of pictures of any size: [batch, 3, height, width], named, not numbered."""
    import onnx as o

    dims = o.load(str(onnx)).graph.input[0].type.tensor_type.shape.dim
    if len(dims) != 4 or dims[1].dim_value != 3 or any(d.dim_value for d in (dims[0], dims[2], dims[3])):
        sys.exit(f"{onnx} doesn't take any size: {[d.dim_value or d.dim_param for d in dims]}")


def record(out, n):
    """live.json for the live.onnx in `out`: round n, and the model's hash and size, which builds fetch it by."""
    data = (out / "live.onnx").read_bytes()
    live = {"round": n, "sha256": hashlib.sha256(data).hexdigest(), "size": len(data)}
    (out / "live.json").write_text(json.dumps(live, indent=1) + "\n", "utf8")
    return live


def main():
    if len(sys.argv) != 2 or not sys.argv[1].isdigit():
        sys.exit("Which round? npm --prefix ai run panels-live -- N")
    n = int(sys.argv[1])
    best = MODELS / f"round-{n}" / "best.pt"
    if not best.exists():
        sys.exit(f"No round {n} in data/model.")
    onnx = export(best)
    check(onnx)
    shutil.copy(onnx, OUT / "live.onnx")
    record(OUT, n)
    print(f"Round {n} is in live.onnx ({onnx.stat().st_size / 1e6:.1f} MB), taking any size. npm run ship puts it live.")


if __name__ == "__main__":
    main()
