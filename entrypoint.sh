#!/bin/sh
set -e

PUID=${PUID:-1000}
PGID=${PGID:-1000}

# 1. Handle Group
# Check if a group with that GID already exists
EXISTING_GROUP=$(getent group "$PGID" | cut -d: -f1)

if [ -z "$EXISTING_GROUP" ]; then
    addgroup -g "$PGID" thinkarr
    GROUP_NAME="thinkarr"
else
    GROUP_NAME="$EXISTING_GROUP"
fi

# 2. Handle User
# Check if a user with that UID already exists
EXISTING_USER=$(getent passwd "$PUID" | cut -d: -f1)

if [ -z "$EXISTING_USER" ]; then
    adduser -u "$PUID" -G "$GROUP_NAME" -D -H thinkarr
    USER_NAME="thinkarr"
else
    USER_NAME="$EXISTING_USER"
fi

# 3. Fix Permissions
chown -R "$PUID:$PGID" /config

echo "Starting Thinkarr as $USER_NAME ($PUID) in group $GROUP_NAME ($PGID)"

exec su-exec "$PUID:$PGID" node server.js