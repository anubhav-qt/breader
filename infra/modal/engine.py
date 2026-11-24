"""Breader's engine on Modal: the voices and the panel model, on call (ADR 0004).

The same engine as the ThinkPad's (server/src/engine/, `node dist/engine/main.js`), from the same
image, speaking the same protocol (/v1/info, /v1/run, /v1/progress, /v1/stop) and asking for the
same ENGINE_TOKEN. An API lists it in ENGINE_FALLBACK_URLS and hands it a job only when every engine
in ENGINE_URLS is down or busy (Azure and GCP have none there, so it's theirs alone). The API asks
it nothing while no jobs come (server/src/engine/index.ts), so it stops and costs nothing.

One container at most: the API keeps track of each worker in it, so every request must reach the
same one. It stops after two quiet minutes.

Deploy (needs a Modal account with a card on file; leave it out by not setting
ENGINE_FALLBACK_URLS anywhere):

    pip install modal && modal setup
    modal secret create breader-engine ENGINE_TOKEN=<the same token as the APIs'>
    modal deploy infra/modal/engine.py

Its address is printed by the deploy: https://<workspace>--breader-engine-engine.modal.run.
BREADER_IMAGE picks another tag of the image (default: latest).
"""

import os
import subprocess

import modal

IMAGE = os.environ.get("BREADER_IMAGE", "ghcr.io/anubhav-qt/breader-server:latest")
PORT = 8790

image = (
    modal.Image.from_registry(IMAGE, add_python="3.12")
    # The image's own entrypoint (tini) is the server's; Modal starts the engine itself below.
    .entrypoint([])
    .env(
        {
            "ROLE": "engine",
            "ENGINE_PORT": str(PORT),
            "SPEECH_DIR": "/data/voices",
            # Sized here, not from the machine: Modal's hosts have more cores than this container may use.
            "ENGINE_WORKERS": "1",
            "ENGINE_THREADS": "2",
            "ENGINE_MEMORY_MB": "2048",
            "ENGINE_LOW_MB": "512",
            "NODE_ENV": "production",
        }
    )
)

app = modal.App("breader-engine")

# The voices' files, fetched once and kept between starts.
voices = modal.Volume.from_name("breader-voices", create_if_missing=True)


@app.function(
    image=image,
    secrets=[modal.Secret.from_name("breader-engine")],
    volumes={"/data/voices": voices},
    cpu=2.0,
    memory=3072,
    min_containers=0,
    max_containers=1,
    scaledown_window=120,
)
@modal.concurrent(max_inputs=32)
@modal.web_server(PORT, startup_timeout=120)
def engine():
    subprocess.Popen(["node", "--enable-source-maps", "dist/engine/main.js"], cwd="/app")
