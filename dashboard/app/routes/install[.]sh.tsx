import { config } from "~/lib/config.server";
import {
  agentConfigYaml,
  controlsTransformYaml,
  defaultSnapshot,
} from "~/lib/agent/vector-config.server";

// One-command agent installer. Always ships container logs and, where the
// host runs PM2, PM2's log files (Vector). Hop records are detected and
// labelled kind="hop", the sensitive-data filter runs before anything leaves
// the host, and hop metrics are remote-written (design 4, 5, 19). The agent's
// switches and filter patterns are read from backwork with the project token
// every 30 s by the backwork-agent-controls container; Vector reloads when they
// change. Optionally ships host/container metrics via vmagent.
//   curl -fsSL https://backwork.dev/install.sh | sh -s -- --token <TOKEN> [--name <host>] [--metrics host|container|all|none] [--pm2-logs <dir>]

/** Poll loop run inside the agent's own Vector image (busybox sh + wget). */
const POLL_SCRIPT = `#!/bin/sh
# backwork agent controls poller. Usage: poll.sh once|loop
# Fetches this project's switches and filter as a Vector transform, validates
# it together with the agent config, and swaps it in when it changed.
set -u
OUT=/controls/controls.yaml
fetch() {
  if wget -q -T 10 -O /tmp/controls.new --header "Authorization: Bearer $TOKEN" "$ENDPOINT/controls?format=vector"; then
    if ! cmp -s /tmp/controls.new "$OUT" 2>/dev/null; then
      if vector validate --no-environment /agent/agent.yaml /tmp/controls.new >/tmp/validate.log 2>&1; then
        cp /tmp/controls.new /controls/.controls.tmp && mv /controls/.controls.tmp "$OUT"
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
  const script = `#!/bin/sh
set -e
TOKEN=""
NAME="$(hostname)"
ENDPOINT="${base}/ingest"
METRICS="host"
PM2_LOGS=""
LOG_IMAGE="timberio/vector:0.43.1-alpine"
NODE_IMAGE="quay.io/prometheus/node-exporter:v1.8.2"
CADVISOR_IMAGE="gcr.io/cadvisor/cadvisor:v0.52.1"
VMAGENT_IMAGE="victoriametrics/vmagent:v1.106.1"
while [ $# -gt 0 ]; do
  case "$1" in
    --token) TOKEN="$2"; shift 2;;
    --name) NAME="$2"; shift 2;;
    --endpoint) ENDPOINT="$2"; shift 2;;
    --metrics) METRICS="$2"; shift 2;;
    --pm2-logs) PM2_LOGS="$2"; shift 2;;
    *) echo "unknown arg: $1"; shift;;
  esac
done
if [ -z "$TOKEN" ]; then
  echo "backwork agent installer"
  echo "usage: curl -fsSL ${base}/install.sh | sh -s -- --token <TOKEN> [--name <hostname>] [--metrics host|container|all|none] [--pm2-logs <dir>]"
  exit 1
fi
command -v docker >/dev/null 2>&1 || { echo "error: docker is required"; exit 1; }
METRICS_ENDPOINT="$ENDPOINT/metrics/api/v1/write"
docker network create backwork-net >/dev/null 2>&1 || true
mkdir -p /etc/backwork/vector /etc/backwork/no-pm2

# PM2 log directory (services that do not run in Docker, design 4).
if [ -z "$PM2_LOGS" ]; then
  for d in "\${PM2_HOME:-}/logs" "$HOME/.pm2/logs" /root/.pm2/logs /home/*/.pm2/logs; do
    if [ -d "$d" ]; then PM2_LOGS="$d"; break; fi
  done
fi
if [ -n "$PM2_LOGS" ] && [ -d "$PM2_LOGS" ]; then
  echo "backwork: reading PM2 logs from $PM2_LOGS"
else
  PM2_LOGS=/etc/backwork/no-pm2
fi

# ---------- agent config ----------
cat > /etc/backwork/vector/agent.yaml <<'VECTORCFG'
${agentYaml}VECTORCFG
cat > /etc/backwork/vector/controls.default.yaml <<'CONTROLSCFG'
${defaultControls}CONTROLSCFG
cat > /etc/backwork/vector/poll.sh <<'POLLSH'
${POLL_SCRIPT}POLLSH
sed -i "s|__NAME__|$NAME|g; s|__ENDPOINT__|$ENDPOINT|g; s|__TOKEN__|$TOKEN|g" /etc/backwork/vector/agent.yaml
chmod 600 /etc/backwork/vector/agent.yaml

# ---------- switches and filter (read from backwork, reloaded on change) ----------
docker volume create backwork-agent-controls >/dev/null
docker rm -f backwork-agent-controls >/dev/null 2>&1 || true
POLL_RUN="--network backwork-net -e TOKEN=$TOKEN -e ENDPOINT=$ENDPOINT -v backwork-agent-controls:/controls -v /etc/backwork/vector:/agent:ro --entrypoint /bin/sh $LOG_IMAGE /agent/poll.sh"
docker run --rm $POLL_RUN once
docker run -d --name backwork-agent-controls --restart unless-stopped $POLL_RUN loop >/dev/null

# ---------- logs (always) ----------
docker rm -f backwork-agent >/dev/null 2>&1 || true
docker run -d --name backwork-agent --restart unless-stopped --network backwork-net \\
  -v /var/run/docker.sock:/var/run/docker.sock:ro \\
  -v /etc/backwork/vector/agent.yaml:/etc/vector/agent.yaml:ro \\
  -v backwork-agent-controls:/etc/vector/controls:ro \\
  -v "$PM2_LOGS":/pm2-logs:ro \\
  -v backwork-agent-data:/var/lib/backwork-vector \\
  "$LOG_IMAGE" --config /etc/vector/agent.yaml --config-dir /etc/vector/controls --watch-config >/dev/null
echo "backwork: shipping logs and hop records from '$NAME'"

# ---------- metrics (optional) ----------
if [ "$METRICS" != "none" ]; then
  SCRAPE=""
  if [ "$METRICS" = "host" ] || [ "$METRICS" = "all" ]; then
    docker rm -f backwork-node-exporter >/dev/null 2>&1 || true
    docker run -d --name backwork-node-exporter --restart unless-stopped --network backwork-net \\
      --pid host -v "/:/host:ro,rslave" \\
      "$NODE_IMAGE" --path.rootfs=/host >/dev/null
    SCRAPE="$SCRAPE  - job_name: node\\n    static_configs: [{targets: [\\"backwork-node-exporter:9100\\"]}]\\n"
    echo "backwork: shipping host metrics (node-exporter)"
  fi
  if [ "$METRICS" = "container" ] || [ "$METRICS" = "all" ]; then
    docker rm -f backwork-cadvisor >/dev/null 2>&1 || true
    docker run -d --name backwork-cadvisor --restart unless-stopped --network backwork-net \\
      -v /:/rootfs:ro -v /var/run:/var/run:ro -v /sys:/sys:ro -v /var/lib/docker/:/var/lib/docker:ro \\
      "$CADVISOR_IMAGE" -docker_only >/dev/null 2>&1 || \\
      docker run -d --name backwork-cadvisor --restart unless-stopped --network backwork-net \\
      -v /:/rootfs:ro -v /var/run:/var/run:ro -v /sys:/sys:ro -v /var/lib/docker/:/var/lib/docker:ro \\
      "$CADVISOR_IMAGE" >/dev/null
    SCRAPE="$SCRAPE  - job_name: cadvisor\\n    static_configs: [{targets: [\\"backwork-cadvisor:8080\\"]}]\\n"
    echo "backwork: shipping container metrics (cAdvisor)"
  fi
  printf "global:\\n  scrape_interval: 30s\\n  external_labels:\\n    host: %s\\nscrape_configs:\\n%b" "$NAME" "$SCRAPE" > /etc/backwork/scrape.yml
  docker rm -f backwork-vmagent >/dev/null 2>&1 || true
  docker run -d --name backwork-vmagent --restart unless-stopped --network backwork-net \\
    -v /etc/backwork/scrape.yml:/etc/vmagent/scrape.yml:ro \\
    "$VMAGENT_IMAGE" \\
    -promscrape.config=/etc/vmagent/scrape.yml \\
    -remoteWrite.url="$METRICS_ENDPOINT" \\
    -remoteWrite.bearerToken="$TOKEN" >/dev/null
fi

echo "Done. View your data at ${base} (logs immediately; metrics within ~1 min)."
`;
  return new Response(script, {
    status: 200,
    headers: { "content-type": "text/x-shellscript; charset=utf-8" },
  });
}
