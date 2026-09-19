#!/bin/sh
set -e

exec /usr/local/bin/pocketbase serve \
  --http="0.0.0.0:8090" \
  --dir="/app/pb_data" \
  --publicDir="/app/pb_public" \
  --migrationsDir="/app/pb_migrations" \
  --automigrate=false
