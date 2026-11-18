import SwiftUI

/// Fleet details are a trailing, removable split item. NavigationSplitView's
/// visibility controls only leading columns, so it cannot dismiss this pane.
struct DesktopPodNavigationLayout<Sidebar: View, Fleet: View, Detail: View>: View {
    let isFleet: Bool
    let showsDetails: Bool
    @State private var visibility: NavigationSplitViewVisibility = .automatic
    @ViewBuilder var sidebar: () -> Sidebar
    @ViewBuilder var fleet: () -> Fleet
    @ViewBuilder var detail: () -> Detail

    var body: some View {
        if isFleet {
            NavigationSplitView(columnVisibility: $visibility) {
                sidebar()
            } detail: {
                HSplitView {
                    fleet().frame(maxWidth: .infinity, maxHeight: .infinity)
                    if showsDetails {
                        detail().frame(minWidth: 350, idealWidth: 720, maxWidth: .infinity)
                    }
                }
            }
            .navigationSplitViewStyle(.balanced)
        } else {
            NavigationSplitView(columnVisibility: $visibility) {
                sidebar()
            } content: {
                fleet()
            } detail: {
                detail()
            }
            .navigationSplitViewStyle(.balanced)
        }
    }
}
