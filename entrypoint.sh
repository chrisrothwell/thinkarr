#!/bin/sh
set -e

PUID=${PUID:-1000}
PGID=${PGID:-1000}

# Create group and user if they don't exist
if ! getent group thinkarr >/dev/null 2>&1; then
  addgroup -g "$PGID" thinkarr
fi

if ! getent passwd thinkarr >/dev/null 2>&1; then
  adduser -u "$PUID" -G thinkarr -D -H thinkarr
fi

# Ensure /config is owned by the right user
chown -R "$PUID:$PGID" /config

echo "Starting Thinkarr (UID=$PUID, GID=$PGID)"

# Run as the specified user
exec su-exec "$PUID:$PGID" node server.js
