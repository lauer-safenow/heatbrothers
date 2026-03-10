#!/bin/sh
set -e

# Validate required environment variables
: "${EMAIL:?ERROR: EMAIL is required}"
: "${PASSWORD:?ERROR: PASSWORD is required}"
: "${AUTH_ENDPOINT:?ERROR: AUTH_ENDPOINT is required}"

# Ensure data directory is writable (volume mount may override ownership)
if [ ! -w /app/data ]; then
  echo "ERROR: /app/data is not writable by current user ($(whoami), uid=$(id -u))" >&2
  echo "Fix: ensure the host directory is owned by uid $(id -u)" >&2
  exit 1
fi

echo "Running database migrations..."
pnpm db:deploy

echo "Starting server..."
exec pnpm serve
