#!/bin/sh
set -eu
umask 077

auth_directory=${PLATFORM_AUTH_DIRECTORY:-/auth}
runtime_directory=${PROXY_RUNTIME_DIRECTORY:-/runtime}
auth_source=${AUTH_PROXY_SOURCE_DIRECTORY:-/opt/widefleet-auth}
auth_worker=${AUTH_PROXY_WORKER:-$auth_source/worker.js}
auth_token=$auth_directory/control-token

mkdir -p "$auth_directory" "$runtime_directory"
if [ ! -e "$auth_token" ]; then
  od -An -N32 -tx1 /dev/urandom | tr -d ' \n' > "$auth_token.tmp"
  mv "$auth_token.tmp" "$auth_token"
fi
auth_key=$(cat "$auth_token")
case "$auth_key" in
  ''|*[!a-zA-Z0-9_-]*) echo 'Invalid auth proxy key' >&2; exit 1 ;;
esac
if [ "${#auth_key}" -lt 32 ]; then
  echo 'Invalid auth proxy key' >&2
  exit 1
fi

cp "$auth_worker" "$runtime_directory/worker.js"
sed "s/__AUTH_PROXY_KEY__/$auth_key/" "$auth_source/wrangler.json" > "$runtime_directory/wrangler.json"
unset auth_key
celld deploy "$runtime_directory"

export CELLD_WATCH="$runtime_directory/cache"
exec celld --listen 0.0.0.0:4180 --internal-listen 127.0.0.1:4182 --advertise 127.0.0.1:4182 --trust-forwarded-headers
