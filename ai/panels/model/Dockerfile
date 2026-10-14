# The panel model's trainer (README.md): PyTorch built for CUDA 12.8, which the RTX 50 cards need,
# and Ultralytics' YOLO. The pages, labels and models stay in data/, mounted at /data, never baked in.
FROM pytorch/pytorch:2.11.0-cuda12.8-cudnn9-runtime
# OpenCV, which Ultralytics reads pictures with, wants these.
RUN apt-get update && apt-get install -y --no-install-recommends libgl1 libglib2.0-0 \
  && rm -rf /var/lib/apt/lists/*
# Beside the image's own PyTorch, in its system Python, which Ubuntu guards unless told.
RUN pip install --no-cache-dir --break-system-packages ultralytics==8.4.166
WORKDIR /app
# Nothing about a run is sent to Ultralytics, and the weights it starts from (trained on photos), the
# ones it checks the GPU with and its font come with the image rather than on each run.
RUN yolo settings sync=False \
  && python -c "from ultralytics import YOLO; YOLO('yolo11s-pose.pt')" \
  && python -c "from ultralytics.utils.downloads import attempt_download_asset as get; get('weights/yolo26n.pt')" \
  && python -c "from ultralytics.utils.checks import check_font; check_font('Arial.ttf')"
COPY *.py ./
