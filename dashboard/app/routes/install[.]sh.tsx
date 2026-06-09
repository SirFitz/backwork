import { config } from "~/lib/config.server";

// One-command agent installer: drops a Vector container on the target host that
// tails its Docker logs and ships them to this backwork instance.
//   curl -fsSL https://backwork.dev/install.sh | sh -s -- --token <TOKEN> --name <host>
export function loader() {
  const base = config.publicUrl;
  const script = `#!/bin/sh
set -e
TOKEN=""
NAME="$(hostname)"
ENDPOINT="${base}/ingest"
IMAGE="timberio/vector:0.43.1-alpine"
while [ $# -gt 0 ]; do
  case "$1" in
    --token) TOKEN="$2"; shift 2;;
    --name) NAME="$2"; shift 2;;
    --endpoint) ENDPOINT="$2"; shift 2;;
    *) echo "unknown arg: $1"; shift;;
  esac
done
if [ -z "$TOKEN" ]; then
  echo "backwork agent installer"
  echo "usage: curl -fsSL ${base}/install.sh | sh -s -- --token <TOKEN> [--name <hostname>]"
  exit 1
fi
command -v docker >/dev/null 2>&1 || { echo "error: docker is required"; exit 1; }
mkdir -p /etc/backwork
cat > /etc/backwork/vector.yaml <<'VECTORCFG'
data_dir: /var/lib/backwork-vector
sources:
  docker:
    type: docker_logs
    exclude_containers: ["backwork-agent"]
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
docker run -d --name backwork-agent --restart unless-stopped \\
  -v /var/run/docker.sock:/var/run/docker.sock:ro \\
  -v /etc/backwork/vector.yaml:/etc/vector/vector.yaml:ro \\
  -v backwork-agent-data:/var/lib/backwork-vector \\
  "$IMAGE" --config /etc/vector/vector.yaml >/dev/null
echo "backwork agent installed. Shipping logs from '$NAME' to $ENDPOINT"
echo "View them at ${base}/logs"
`;
  return new Response(script, {
    status: 200,
    headers: { "content-type": "text/x-shellscript; charset=utf-8" },
  });
}
