#!/bin/sh
# Runs the load test from inside Docker's network, against the side copy (side.sh). From the Mac
# through the published port, Docker's port forwarding gives out first, near 150 readers.
#
#   infra/load/inside.sh --warm
#   infra/load/inside.sh --readers 1000 --minutes 2 --ramp 30
#   GENS=3 infra/load/inside.sh --readers 700 --minutes 2 --ramp 30
#
# GENS: how many load processes to run at once, each with --readers of its own. One Node process
# tops out near 2,000 readers. Each prints its own report.
set -e
here=$(cd "$(dirname "$0")" && pwd)
gens=${GENS:-1}

run() {
  gen=$1
  shift
  docker run --rm --name "breader-load-gen-$gen" --network breader-manga_default \
    -v "$here:/load:ro" breader-server:manga \
    node /load/readers.mjs --base http://breader-load-api:8787 --first "$((gen * 100000))" "$@"
}

g=0
while [ "$g" -lt "$gens" ]; do
  run "$g" "$@" &
  g=$((g + 1))
done
wait
