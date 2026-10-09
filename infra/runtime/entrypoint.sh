#!/bin/sh
set -u
stopping=0
child=
stop() {
  stopping=1
  if [ -n "$child" ]; then kill -TERM "$child" 2>/dev/null || true; fi
}
trap stop TERM INT
while [ "$stopping" -eq 0 ]; do
  /usr/local/bin/celld "$@" &
  child=$!
  wait "$child"
  if [ "$stopping" -eq 1 ]; then
    wait "$child" 2>/dev/null || true
    exit 0
  fi
  # celld requires at least a lease interval before another process takes over.
  sleep 10 &
  child=$!
  wait "$child"
done
