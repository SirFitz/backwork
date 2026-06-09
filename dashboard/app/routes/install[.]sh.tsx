import { config } from "~/lib/config.server";

// One-command agent installer. Always ships container logs (Vector). Optionally
// ships metrics via vmagent scraping node-exporter (host) and/or cAdvisor
// (per-container), remote-written to backwork and isolated to your org.
//   curl -fsSL https://backwork.dev/install.sh | sh -s -- --token <TOKEN> [--name <host>] [--metrics host|container|all|none]
export function loader() {
  const base = config.publicUrl;
  const script = `#!/bin/sh
set -e
TOKEN=""
NAME="$(hostname)"
ENDPOINT="${base}/ingest"
METRICS="host"
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
    *) echo "unknown arg: $1"; shift;;
  esac
done
if [ -z "$TOKEN" ]; then
  echo "backwork agent installer"
  echo "usage: curl -fsSL ${base}/install.sh | sh -s -- --token <TOKEN> [--name <hostname>] [--metrics host|container|all|none]"
  exit 1
fi
command -v docker >/dev/null 2>&1 || { echo "error: docker is required"; exit 1; }
METRICS_ENDPOINT="$ENDPOINT/metrics/api/v1/write"
docker network create backwork-net >/dev/null 2>&1 || true
mkdir -p /etc/backwork

# ---------- logs (always) ----------
cat > /etc/backwork/vector.yaml <<'VECTORCFG'
data_dir: /var/lib/backwork-vector
sources:
  docker:
    type: docker_logs
    exclude_containers: ["backwork-agent","backwork-vmagent","backwork-node-exporter","backwork-cadvisor"]
transforms:
  normalize:
    type: remap
    inputs: [docker]
    source: |
      .service = to_string(.container_name) ?? "unknown"
      .host = "__NAME__"
      .level = "info"
      parsed = parse_json(.message) ?? {}
      lvl = get(parsed, ["level"]) ?? null
      if lvl != null { ln = to_int(lvl) ?? -1; if ln >= 50 { .level = "error" } else if ln >= 40 { .level = "warn" } else if ln >= 30 { .level = "info" } else if ln >= 10 { .level = "debug" } else { .level = downcase(to_string(lvl) ?? "info") } }
      if .level == "info" { m = downcase(to_string(.message) ?? ""); if contains(m, "error") || contains(m, "panic") || contains(m, "fatal") { .level = "error" } else if contains(m, "warn") { .level = "warn" } }
sinks:
  loki:
    type: loki
    inputs: [normalize]
    endpoint: __ENDPOINT__
    auth:
      strategy: bearer
      token: __TOKEN__
    compression: none
    encoding:
      codec: json
    labels:
      service: "{{ service }}"
      host: "{{ host }}"
      level: "{{ level }}"
VECTORCFG
sed -i "s|__NAME__|$NAME|g; s|__ENDPOINT__|$ENDPOINT|g; s|__TOKEN__|$TOKEN|g" /etc/backwork/vector.yaml
docker rm -f backwork-agent >/dev/null 2>&1 || true
docker run -d --name backwork-agent --restart unless-stopped --network backwork-net \\
  -v /var/run/docker.sock:/var/run/docker.sock:ro \\
  -v /etc/backwork/vector.yaml:/etc/vector/vector.yaml:ro \\
  -v backwork-agent-data:/var/lib/backwork-vector \\
  "$LOG_IMAGE" --config /etc/vector/vector.yaml >/dev/null
echo "backwork: shipping logs from '$NAME'"

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
