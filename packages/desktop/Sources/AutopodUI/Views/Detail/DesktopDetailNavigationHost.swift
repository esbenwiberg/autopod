import SwiftUI

/// Only this subtree observes ordinary tab changes; the fleet retains the object.
struct DesktopDetailNavigationHost<Content: View>: View {
    @Bindable var navigation: DesktopDetailNavigation
    @ViewBuilder var content: (Binding<DetailTab?>, Binding<DetailTab?>) -> Content

    var body: some View { content($navigation.selectedTab, $navigation.requestedTab) }
}
