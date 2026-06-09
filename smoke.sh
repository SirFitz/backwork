#!/usr/bin/env bash
# Smoke test for a running backwork stack. Pass the dashboard base URL.
#   ./smoke.sh http://localhost:3000        (local)
#   ./smoke.sh https://backwork...host -k   (live, -k = insecure for fresh certs)
set -u
BASE="${1:-http://localhost:3000}"
CURL="curl -s --max-time 20"
[ "${2:-}" = "-k" ] && CURL="$CURL -k"
pass=0; fail=0
check() { # name, url, expected-substring
  local body code
  body=$($CURL -w $'\n%{http_code}' "$2" 2>/dev/null)
  code=$(printf '%s' "$body" | tail -1)
  body=$(printf '%s' "$body" | sed '$d')
  if [ "$code" = "200" ] && printf '%s' "$body" | grep -qi "$3"; then
    echo "  PASS  $1 ($code)"; pass=$((pass+1))
  else
    echo "  FAIL  $1 (code=$code, missing '$3')"; fail=$((fail+1))
  fi
}
echo "== backwork smoke test :: $BASE =="
check "healthz"        "$BASE/healthz"             "ok"
check "overview"       "$BASE/"                    "Service Health"
check "logs page"      "$BASE/logs"                "Logs"
check "metrics page"   "$BASE/metrics"             "Performance"
check "traces page"    "$BASE/traces"              "Traces"
check "incidents page" "$BASE/incidents"           "Incidents"
check "alerts page"    "$BASE/alerts"              "Alert Rules"
echo "== $pass passed, $fail failed =="
exit $fail
