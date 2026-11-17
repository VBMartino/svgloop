#!/usr/bin/env sh
# Starts llama.cpp's server with a vision-capable model for SVGLoop (Linux/macOS).
# Usage: scripts/start-llama.sh MODEL.gguf MMPROJ.gguf [PORT]
# Environment: LLAMA_SERVER (default llama-server), CONTEXT (16384), ALIAS, FIT_TARGET (MiB of VRAM to leave free)
set -eu
MODEL="${1:?usage: start-llama.sh MODEL.gguf MMPROJ.gguf [PORT]}"
MMPROJ="${2:?usage: start-llama.sh MODEL.gguf MMPROJ.gguf [PORT]}"
PORT="${3:-8080}"
ALIAS="${ALIAS:-$(basename "$MODEL" .gguf)}"
set -- -m "$MODEL" --mmproj "$MMPROJ" --alias "$ALIAS" --host 127.0.0.1 --port "$PORT" \
  -c "${CONTEXT:-16384}" --parallel 1 --jinja
if [ -n "${FIT_TARGET:-}" ]; then set -- "$@" --fit-target "$FIT_TARGET"; fi
echo "Serving $ALIAS at http://127.0.0.1:$PORT/v1"
echo "Set SVGLOOP_BASE_URL=http://127.0.0.1:$PORT/v1 and SVGLOOP_MODEL=$ALIAS"
exec "${LLAMA_SERVER:-llama-server}" "$@"
