---
topics: [validation, desktop, autopod-self]
---

# Autopod-self required facts must run in the Linux pod

Required facts for `autopod-self` must use commands executable in the Linux pod image.
macOS-only desktop validation, including SwiftUI/AppKit `swift test` commands, belongs in
human review or optional local Mac verification until Autopod has a dedicated Mac runner
capability.

Native local-Docker repository `browser-test` commands run in the selected validation
container, with its declared setup/dependencies, restricted network and container-local
application URL. They do not inherit the daemon host's Node/.NET/browser/dependency
installation and never silently fall back to host execution. Exact commands, artifacts,
assertions and review requirements are unchanged. Browser evidence is collected from the
same container. Legacy and sandbox browser-fact host execution remains unchanged; this
does not change host screenshot/health probes or make Mac-only facts executable in Linux.
