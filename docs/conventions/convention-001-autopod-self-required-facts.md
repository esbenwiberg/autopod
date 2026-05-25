---
topics: [validation, desktop, autopod-self]
---

# Autopod-self required facts must run in the Linux pod

Required facts for `autopod-self` must use commands executable in the Linux pod image.
macOS-only desktop validation, including SwiftUI/AppKit `swift test` commands, belongs in
human review or optional local Mac verification until Autopod has a dedicated Mac runner
capability.
