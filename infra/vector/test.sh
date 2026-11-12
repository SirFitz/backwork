#!/bin/sh
# Vector unit tests for the stack collector config (and so for the shared
# transforms the agent uses). Needs Docker.
set -e
cd "$(dirname "$0")"
docker run --rm -v "$PWD":/c timberio/vector:0.43.1-alpine test /c/vector.yaml /c/tests.yaml
