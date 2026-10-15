# R04a: desktop pause and kill observation

Date: 2026-10-15. Source: campaign 74a5b2cf; desktop unchanged from baseline.

## Current behavior

ActionHandler.swift kill at line 211 changes PodStore status to killing before
awaiting the daemon. Failure reports lastError but leaves that invented state.
Pause at line 232 changes to paused immediately; any failure changes to running,
even if a newer server event arrived while the request was pending. Both methods
return Void and record one pendingAction string shared with other operations.
Approve already waits for server acceptance without changing status optimistically.

PodStore.swift refreshSession at line 247 gets a complete daemon snapshot and
merges it with existing state. A statusRevisions snapshot preserves status events
received after the GET began; failed refresh retains current data. updateStatus
at line 330 is the event-driven status mutation seam. Neither successful POST
nor awaiting refresh's Void result alone proves a lifecycle transition.

ReplyDecisionRetentionTests.swift composes a production ActionHandler, PodStore
and DaemonAPI with an ephemeral URLSession and synthetic URLProtocol. No pause/kill
behavior tests were found in the searched test tree. UnverifiedTerminationActionTests
covers other rejected actions retaining failed state.

## Native observation seam

Delegated source research and root store/action inspection identify the smallest
composition: a SwiftUI host observing PodStore and rendering production
DetailPanelView with handler.actions. DetailPanelView has a public initializer
accepting pod/events/actions (line 71). For an ordinary noninteractive nonartifact
pod it starts on Overview and does not mount TerminalTab. Nil quality/preview
loaders make Overview's associated tasks return without network access.

AutopodClientTests already depends on all three desktop libraries. Existing
ConfigurationEditorLayoutTests demonstrates NSHostingView/NSWindow and optional
owned-view PNG capture. Rendering after calling the real action closure proves
action-to-store-to-render composition; it does not prove real button activation.

This seam avoids constructing ConnectionManager, restoring real credentials or
requesting notifications. Full AppRootView cannot currently be constructed with
an inert connection manager. Work-tab children and Logs access standard defaults;
restricted Overview composition is narrower than unrestricted navigation.
No native fixture for this journey has been implemented or run in this research.

## Scope boundaries

Pending request state and reply drafts currently have unsuitable lifetimes for
reconnect: app connection changes recreate ActionHandler; Overview reply text is
view-local and clears before acknowledgement. Those are separate follow-up seams.
This artifact describes pause/kill behavior and an available native rendering
boundary only; it does not establish complete desktop disconnect recovery.
