#!/bin/sh
# Insights scenario (BAC-67), tests only: make shop-api slower, as if a deploy had
# made GET /shop regress, and report that deploy to backwork when the deploy
# endpoint exists (feature 6, POST /ingest/deploys).
#
#   qa/fixtures/deploy.sh [compose project]      start the regression (default project: backwork)
#   qa/fixtures/deploy.sh [compose project] --reset   end it
#
# Optional: BW_URL (e.g. http://localhost:3000) and BW_INGEST_TOKEN (a project
# ingest token) to report the deploy; VERSION (default v-fixture-<time>).
set -eu

PROJECT="${1:-backwork}"
MODE="${2:-}"
TRIGGER="/tmp/bw-regression"

CONTAINER="$(docker ps -q --filter "label=com.docker.compose.project=${PROJECT}" --filter "label=com.docker.compose.service=shop-api" | head -n 1)"
if [ -z "$CONTAINER" ]; then
  echo "no running shop-api container in compose project ${PROJECT}" >&2
  exit 1
fi

if [ "$MODE" = "--reset" ]; then
  docker exec "$CONTAINER" rm -f "$TRIGGER"
  echo "regression ended: GET /shop is back to its usual speed from the next cycle"
  exit 0
fi

docker exec "$CONTAINER" touch "$TRIGGER"
echo "regression started: GET /shop takes about twice as long from the next cycle"

if [ -z "${BW_URL:-}" ] || [ -z "${BW_INGEST_TOKEN:-}" ]; then
  echo "BW_URL or BW_INGEST_TOKEN not set: deploy not reported"
  exit 0
fi

VERSION="${VERSION:-v-fixture-$(date +%s)}"
BODY="{\"service\":\"shop-api\",\"version\":\"${VERSION}\",\"environment\":\"local\",\"actor\":\"qa/fixtures/deploy.sh\"}"
CODE="$(curl -s -o /dev/null -w '%{http_code}' -X POST "${BW_URL%/}/ingest/deploys" \
  -H "authorization: Bearer ${BW_INGEST_TOKEN}" -H "content-type: application/json" --data "$BODY" || true)"
case "$CODE" in
  2*) echo "deploy ${VERSION} reported (${CODE})" ;;
  404|405) echo "deploy endpoint not there yet (${CODE}): feature 6 adds it" ;;
  *) echo "deploy report failed (${CODE})" >&2; exit 1 ;;
esac
