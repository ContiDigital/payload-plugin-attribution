#!/usr/bin/env bash

# Starts a disposable database container for the integration test matrix.
#
#   bash ./scripts/ci/start-database.sh <postgres|mongodb> <image> [container] [host-port]
#
# CI uses the defaults (container payload-plugin-attribution-<database>, the database's
# standard port). Local runs should pass a unique container name and free host port so an
# existing database is never reused. MongoDB starts as a single-member replica set because
# Payload transactions require one.

set -Eeuo pipefail

database="${1:-}"
image="${2:-}"
container="${3:-payload-plugin-attribution-${database}}"

if [[ "$database" != "postgres" && "$database" != "mongodb" ]]; then
  echo "database must be postgres or mongodb" >&2
  exit 2
fi
if [[ -z "$image" ]]; then
  echo "database image is required" >&2
  exit 2
fi
if [[ "$database" == "postgres" ]]; then
  port="${4:-5432}"
else
  port="${4:-27017}"
fi
if docker container inspect "$container" >/dev/null 2>&1; then
  echo "container ${container} already exists; refusing to reuse it" >&2
  exit 2
fi

pulled=false
for attempt in 1 2 3 4 5; do
  if docker pull "$image"; then
    pulled=true
    break
  fi
  if [[ "$attempt" -lt 5 ]]; then
    delay_seconds=$((attempt * 10))
    echo "::warning::Database image pull failed (attempt ${attempt}/5); retrying in ${delay_seconds}s"
    sleep "$delay_seconds"
  fi
done
if [[ "$pulled" != "true" ]]; then
  echo "::error::Database image pull failed after 5 attempts"
  exit 1
fi

if [[ "$database" == "postgres" ]]; then
  docker run --detach \
    --env POSTGRES_DB=attribution_test \
    --env POSTGRES_PASSWORD=postgres \
    --env POSTGRES_USER=postgres \
    --name "$container" \
    --publish "127.0.0.1:${port}:5432" \
    "$image"
else
  # mongod needs far more descriptors than a 1024 default once many Payload pools connect.
  docker run --detach \
    --name "$container" \
    --publish "127.0.0.1:${port}:27017" \
    --ulimit nofile=64000:64000 \
    "$image" \
    --replSet rs0 --bind_ip_all
fi

mongo_ready() {
  # Initiates the replica set once, then waits until this member is primary. The member
  # host is the in-container address; clients connect with directConnection=true.
  docker exec "$container" mongosh --quiet --eval '
    try {
      rs.status()
    } catch (error) {
      rs.initiate({ _id: "rs0", members: [{ _id: 0, host: "localhost:27017" }] })
    }
    quit(db.hello().isWritablePrimary ? 0 : 1)
  ' >/dev/null 2>&1
}

for _attempt in {1..30}; do
  if [[ "$database" == "postgres" ]]; then
    # The image restarts the server once after initialization, so readiness must be
    # observed over TCP, which the temporary init server does not listen on.
    if docker exec "$container" pg_isready -h 127.0.0.1 -U postgres -d attribution_test >/dev/null 2>&1; then
      exit 0
    fi
  elif mongo_ready; then
    exit 0
  fi
  sleep 2
done

docker logs "$container"
echo "::error::${database} did not become ready within 60 seconds"
exit 1
