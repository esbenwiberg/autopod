---
date: 2026-10-15
researcher: Codex
git_commit: 1ace904a8a1ae744901a8c0a90aa604261292200
branch: codex/reliability
status: complete
---

# Existing command palette input ownership

Campaign R07 research. research_cli inspected sources at36566b48; relevant files
remain unchanged at1ace904a. Root read CommandPalette and its tests completely,
checked live MainView search/mount wiring, and read TerminalEmulatorView and
VillageWebView for native callback lifecycle patterns. No runtime reproduction
or product edit was performed for this report.

CommandPalette is a SwiftUI value holding arrays and callbacks. Its body recomputes
rows from current inputs. onAppear installs one local keyDown monitor whose closure
captures that view value. Query and selectedIndex are State-backed; pod/profile
arrays, actions and selection callbacks are ordinary stored values. Return and
arrow handling invokes methods through the captured value. MainView passes live
pod/profile arrays into the same mounted palette. Existing tests only exercise
static result construction. There is no mounted palette event-delivery test.

This supports a source-inferred mismatch: after a refresh removes A and displays B
at the same row, the retained keyboard closure can still use A. Likewise callback
replacement can leave keyboard execution on the old owner. Native delivery needs
reproduction before claiming an observed bug. Mouse rows use their current item.
The local monitor checks isPresented but not event.window, so its scope is the
application rather than the specific palette window.

Pod result titles display pod.branch, while MainView.searchPods matches ID, brief
title, task, profile and series but excludes branch. Exact branch-only searches can
therefore omit a title visible in the initial result list. This is a separate scope
choice, not included automatically in a keyboard-lifetime repair.

Existing NSViewRepresentable patterns refresh callback references in updateNSView:
TerminalEmulatorView updates its coordinator's send/resize closures; VillageWebView
updates selection/failure closures and disposes its bridge in dismantleNSView.
The terminal local scroll monitor is a reference-owner pattern, not a model for
palette window scoping. MainView's apparent old-ID unsubscribe was not established
as lost/duplicate delivery because desktop socket subscription is global.

References: AutopodUI/Views/CommandPalette/CommandPalette.swift:5,70,151,187,306;
AutopodUI/Views/Shell/MainView.swift:373,863; Tests/AutopodUITests/CommandPaletteTests.swift;
AutopodUI/Terminal/TerminalEmulatorView.swift; AutopodUI/Views/Village/VillageWebView.swift.
