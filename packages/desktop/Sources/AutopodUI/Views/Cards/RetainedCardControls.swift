import SwiftUI

/// Open the owning Recovery Hub page, never issue a control directly from a fleet card.
struct RetainedCardControls: View {
  let pod: Pod
  let actions: PodActions
  let disabled: Bool
  @State private var route: RecoveryRoute?

  var body: some View {
    ViewThatFits {
      HStack(spacing: 6) { entries }
      VStack(alignment: .leading, spacing: 4) { entries }
    }
    .controlSize(.small).disabled(disabled)
    .frame(maxWidth: .infinity, alignment: .leading)
    .padding(.horizontal, 12).padding(.bottom, 8)
    .sheet(item: $route) { destination in
      RecoveryHubSheet(pod: pod, actions: actions, model: RecoveryHubModel(podId: pod.id, actions: actions),
        initialRoute: destination)
    }
  }

  @ViewBuilder private var entries: some View {
    if pod.status != .killed {
      Button("Stop and retain…") { route = .finalization }
        .help("End execution without reclaiming storage.")
        .accessibilityIdentifier("pod-control-stop-retain-\(pod.id)")
    }
    Button("Delete & free resources…") { route = .freeStorage }
      .help("Inspect retained Docker and host targets. Opening this does not delete anything.")
      .accessibilityIdentifier("pod-control-cleanup-retained-\(pod.id)")
  }
}
