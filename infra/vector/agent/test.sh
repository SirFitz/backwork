#!/bin/sh
# Vector unit tests for the agent config with switches and an org pattern.
set -e
cd "$(dirname "$0")"
(cd ../../../dashboard && bun ../infra/vector/agent/generate.ts)
docker run --rm -v "$PWD":/c timberio/vector:0.43.1-alpine test /c/build/agent.yaml /c/build/controls.yaml /c/tests.yaml
