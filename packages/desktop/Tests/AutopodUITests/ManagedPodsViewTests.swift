import Testing
@testable import AutopodUI

@MainActor
@Test func managedPodsHaveASeparateSidebarDestination() {
  #expect(SidebarItem.managedPods.label == "Managed Pods")
  #expect(MainView.filterPods([], for: .managedPods).isEmpty)
}
