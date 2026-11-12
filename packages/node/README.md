# @sirfitz/backwork (Node and Bun): retired

This package sent OpenTelemetry spans to backwork. It is retired: backwork no
longer stores spans (BAC-49, 2026-11-12). Its code was removed from this
repository and remains in the git history before that change.

The way in is now **Correlator**. A service that uses Correlator writes hop
records beside its ordinary log lines; the backwork agent (`curl -fsSL
https://backwork.dev/install.sh | sh`) ships them, and backwork shows every
request in the request view, the Requests list and the Performance page. See
the Docs page on backwork.dev.
