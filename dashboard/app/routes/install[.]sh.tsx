import { config } from "~/lib/config.server";
import {
  agentConfigYaml,
  controlsTransformYaml,
  defaultSnapshot,
} from "~/lib/agent/vector-config.server";

// One-command agent installer. The agent is Vector only: it ships container
// logs and, where the host runs PM2, PM2's log files; hop records are detected
// and labelled kind="hop", the sensitive-data filter runs before anything
// leaves the host, and hop metrics are remote-written (design 4, 5, 19). The
// agent's switches and filter patterns are read from backwork with the project
// token every 30 s by the backwork-agent-controls container; Vector reloads
// when they change.
//   curl -fsSL https://backwork.dev/install.sh | sh -s -- --token <TOKEN> [--name <host>]
//     [--include <prefix,...>] [--instance <slug>] [--pm2-logs <dir>] [--config-dir <dir>]
// --include   only containers whose names start with one of these prefixes
// --instance  run a second agent on the same host (other project/token):
//             names become backwork-agent-<slug>, config /etc/backwork/<slug>

/** Poll loop run inside the agent's own Vector image (busybox sh + wget). */
const POLL_SCRIPT = `#!/bin/sh
# backwork agent controls poller. Usage: poll.sh once|loop
# Fetches this project's switches and filter as a Vector transform, validates
# it together with the agent config, and swaps it in when it changed.
set -u
OUT=/controls/controls.yaml
fetch() {
  if wget -q -T 10 -O /tmp/controls.new.yaml --header "Authorization: Bearer $TOKEN" "$ENDPOINT/controls?format=vector"; then
    if ! cmp -s /tmp/controls.new.yaml "$OUT" 2>/dev/null; then
      if vector validate --no-environment /agent/agent.yaml /tmp/controls.new.yaml >/tmp/validate.log 2>&1; then
        cp /tmp/controls.new.yaml /controls/.controls.tmp && mv /controls/.controls.tmp "$OUT"
        echo "backwork-agent-controls: updated $(grep -o 'Version [a-z0-9]*' "$OUT" | head -1)"
      else
        echo "backwork-agent-controls: rejected invalid controls"; cat /tmp/validate.log
      fi
    fi
  else
    echo "backwork-agent-controls: backwork unreachable, keeping current controls"
  fi
  [ -s "$OUT" ] || cp /agent/controls.default.yaml "$OUT"
}
if [ "\${1:-loop}" = "once" ]; then fetch; exit 0; fi
while true; do fetch; sleep 30; done
`;

export function loader() {
  const base = config.publicUrl;
  const agentYaml = agentConfigYaml();
  const defaultControls = controlsTransformYaml(defaultSnapshot());
  const usage = `usage: curl -fsSL ${base}/install.sh | sh -s -- --token <TOKEN> [--name <hostname>] [--include <prefix,...>] [--instance <slug>] [--pm2-logs <dir>] [--config-dir <dir>]`;
  const script = `#!/bin/sh
set -e
TOKEN=""
NAME="$(hostname)"
ENDPOINT="${base}/ingest"
PM2_LOGS=""
INCLUDE=""
INSTANCE=""
CONF=""
LOG_IMAGE="timberio/vector:0.43.1-alpine"
while [ $# -gt 0 ]; do
  case "$1" in
    --token) TOKEN="$2"; shift 2;;
    --name) NAME="$2"; shift 2;;
    --endpoint) ENDPOINT="$2"; shift 2;;
    --include) INCLUDE="$2"; shift 2;;
    --instance) INSTANCE="$2"; shift 2;;
    --pm2-logs) PM2_LOGS="$2"; shift 2;;
    --config-dir) CONF="$2"; shift 2;;
    --metrics) echo "note: --metrics is no longer supported (the agent ships logs, hop records and hop metrics only)"; shift 2;;
    *) echo "unknown arg: $1"; shift;;
  esac
done
if [ -z "$TOKEN" ]; then
  echo "backwork agent installer"
  echo "${usage}"
  exit 1
fi
command -v docker >/dev/null 2>&1 || { echo "error: docker is required"; exit 1; }
case "$INSTANCE" in
  "") SUFFIX="";;
  *[!a-z0-9-]*) echo "error: --instance must be lowercase letters, digits and dashes"; exit 1;;
  *) SUFFIX="-$INSTANCE";;
esac
case "$INCLUDE" in
  *[!A-Za-z0-9_.,-]*) echo "error: --include takes container-name prefixes separated by commas"; exit 1;;
esac
[ -n "$CONF" ] || { if [ -n "$INSTANCE" ]; then CONF="/etc/backwork/$INSTANCE"; else CONF="/etc/backwork"; fi; }
AGENT="backwork-agent$SUFFIX"
CONTROLS="backwork-agent-controls$SUFFIX"
docker network create backwork-net >/dev/null 2>&1 || true
mkdir -p "$CONF/vector" "$CONF/no-pm2"

# PM2 log directory (services that do not run in Docker, design 4).
if [ -z "$PM2_LOGS" ]; then
  for d in "\${PM2_HOME:-}/logs" "$HOME/.pm2/logs" /root/.pm2/logs /home/*/.pm2/logs; do
    if [ -d "$d" ]; then PM2_LOGS="$d"; break; fi
  done
fi
if [ -n "$PM2_LOGS" ] && [ -d "$PM2_LOGS" ]; then
  echo "backwork: reading PM2 logs from $PM2_LOGS"
else
  PM2_LOGS="$CONF/no-pm2"
fi

# ---------- agent config ----------
cat > "$CONF/vector/agent.yaml" <<'VECTORCFG'
${agentYaml}VECTORCFG
cat > "$CONF/vector/controls.default.yaml" <<'CONTROLSCFG'
${defaultControls}CONTROLSCFG
cat > "$CONF/vector/poll.sh" <<'POLLSH'
${POLL_SCRIPT}POLLSH
if [ -n "$INCLUDE" ]; then
  INC_LIST="$(printf '%s' "$INCLUDE" | sed 's/[^,][^,]*/"&"/g; s/,/, /g')"
  sed "s|__INCLUDE__|$INC_LIST|" "$CONF/vector/agent.yaml" > "$CONF/vector/agent.yaml.tmp"
else
  sed '/__INCLUDE__/d' "$CONF/vector/agent.yaml" > "$CONF/vector/agent.yaml.tmp"
fi
sed "s|__NAME__|$NAME|g; s|__ENDPOINT__|$ENDPOINT|g; s|__TOKEN__|$TOKEN|g" "$CONF/vector/agent.yaml.tmp" > "$CONF/vector/agent.yaml"
rm -f "$CONF/vector/agent.yaml.tmp"
chmod 600 "$CONF/vector/agent.yaml"

# ---------- switches and filter (read from backwork, reloaded on change) ----------
docker volume create "$CONTROLS" >/dev/null
docker rm -f "$CONTROLS" >/dev/null 2>&1 || true
POLL_RUN="--network backwork-net -e TOKEN=$TOKEN -e ENDPOINT=$ENDPOINT -v $CONTROLS:/controls -v $CONF/vector:/agent:ro --entrypoint /bin/sh $LOG_IMAGE /agent/poll.sh"
docker run --rm $POLL_RUN once
docker run -d --name "$CONTROLS" --restart unless-stopped $POLL_RUN loop >/dev/null

# ---------- the agent ----------
docker rm -f "$AGENT" >/dev/null 2>&1 || true
docker run -d --name "$AGENT" --restart unless-stopped --network backwork-net \\
  -v /var/run/docker.sock:/var/run/docker.sock:ro \\
  -v "$CONF/vector/agent.yaml":/etc/vector/agent.yaml:ro \\
  -v "$CONTROLS":/etc/vector/controls:ro \\
  -v "$PM2_LOGS":/pm2-logs:ro \\
  -v "backwork-agent-data$SUFFIX":/var/lib/backwork-vector \\
  "$LOG_IMAGE" --config /etc/vector/agent.yaml --config-dir /etc/vector/controls --watch-config >/dev/null
echo "backwork: $AGENT shipping logs, hop records and hop metrics from '$NAME'\${INCLUDE:+ (containers: $INCLUDE)}"
echo "Done. View your data at ${base}."
`;
  return new Response(script, {
    status: 200,
    headers: { "content-type": "text/x-shellscript; charset=utf-8" },
  });
}
