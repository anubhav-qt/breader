#!/bin/sh
# The panel model's trainer on a Mac (README.md): the same train.py and guess.py as in Docker, in a
# Python of their own beside them (.venv, made with uv the first time), on the Mac's GPU.
#   npm --prefix ai run panels-train-mac
#   npm --prefix ai run panels-guess-mac
set -e
cd "$(dirname "$0")"
if [ ! -x .venv/bin/python ]; then
  uv venv --python 3.12 .venv
  uv pip install --python .venv/bin/python torch==2.11.0 ultralytics==8.4.166
fi
export PANELS_DATA="$PWD/../data"
export PANELS_DEVICE=mps
.venv/bin/yolo settings sync=False > /dev/null
exec .venv/bin/python "$@"
