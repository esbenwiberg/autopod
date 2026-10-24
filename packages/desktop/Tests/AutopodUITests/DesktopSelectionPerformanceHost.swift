import AppKit
import Observation
import SwiftUI
import Testing
@testable import AutopodUI

@MainActor @Observable final class DesktopSelectionInputs {
    var selectedID: String? = "perf-0000"
}

@MainActor final class DesktopSelectionPerformanceHost {
    let inputs = DesktopSelectionInputs()
    let window: NSWindow
    let hosting: NSHostingView<AnyView>
    private let defaults: UserDefaults
    private let suite = "desktop-selection-" + UUID().uuidString

    init() throws {
        NSApplication.shared.finishLaunching()
        defaults = try #require(UserDefaults(suiteName: suite))
        defaults.set(true, forKey: "autopod.desktop.redesign")
        defaults.set("dark", forKey: "autopod.desktop.appearance")
        let state = inputs
        let view = DesktopPerformanceFixtures.mainView(selection: Binding(
            get: { state.selectedID }, set: { state.selectedID = $0 }))
            .defaultAppStorage(defaults)
            .transaction { $0.disablesAnimations = true }
            .frame(width: 1_800, height: 1_050)
        hosting = NSHostingView(rootView: AnyView(view))
        hosting.sizingOptions = []
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1_800, height: 1_050),
            styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = hosting
        hosting.appearance = NSAppearance(named: .darkAqua)
        NSApplication.shared.accessibilitySetValue(true,
            forAttribute: NSAccessibility.Attribute(rawValue: "AXEnhancedUserInterface"))
        window.orderFront(nil)
    }

    func close() {
        window.contentView = nil
        window.close()
        defaults.removePersistentDomain(forName: suite)
    }

    func layout() { window.layoutIfNeeded(); hosting.layoutSubtreeIfNeeded() }
    func value(_ node: NSObject, _ key: String) -> Any? {
        let alternate = "is" + key.prefix(1).uppercased() + key.dropFirst()
        guard node.responds(to: NSSelectorFromString(key))
            || node.responds(to: NSSelectorFromString(alternate)) else { return nil }
        return node.value(forKey: key)
    }
    private func descendants(_ node: NSObject) -> [NSObject] {
        [node] + (value(node, "accessibilityChildren") as? [NSObject] ?? []).flatMap(descendants)
    }
    var nodes: [NSObject] { descendants(hosting) }
    func label(_ node: NSObject) -> String { value(node, "accessibilityLabel") as? String ?? "" }
    func find(id: String) -> NSObject? {
        nodes.first { value($0, "accessibilityIdentifier") as? String == id }
    }
    func find(label prefix: String) -> NSObject? {
        nodes.first { label($0).hasPrefix(prefix) && $0.responds(to: NSSelectorFromString("accessibilityPerformPress")) }
    }
    func press(_ node: NSObject) { _ = value(node, "accessibilityPerformPress") }
    func contains(_ text: String) -> Bool {
        nodes.contains { label($0).contains(text)
            || (value($0, "accessibilityValue") as? String ?? "").contains(text) }
    }
    func wait(_ predicate: () -> Bool) async throws {
        let deadline = ContinuousClock.now.advanced(by: .seconds(5))
        repeat {
            layout()
            guard ContinuousClock.now < deadline else { throw URLError(.timedOut) }
            if predicate() { return }
            try await Task.sleep(for: .milliseconds(1))
        } while true
    }
    func scope(_ scope: String) async throws {
        layout()
        press(try #require(find(label: scope == "active" ? "Active" : "All pods")))
        try await wait { self.contains(scope == "active" ? "10 pods" : "50 pods") }
        if scope == "repository" {
            press(try #require(find(label: "fixture/repository-0")))
            try await wait { self.contains("Showing 50 of 100") }
        }
    }
    func selectTab(_ tab: String) async throws {
        layout()
        if destination(tab) { return }
        press(try #require(find(id: "detail-tab-\(tab)")))
        try await wait { self.destination(tab) }
    }
    func destination(_ tab: String) -> Bool {
        let current = nodes
        guard let node = current.first(where: { value($0, "accessibilityIdentifier") as? String == "detail-tab-\(tab)" }),
              value(node, "accessibilitySelected") as? Bool == true,
              let id = inputs.selectedID, current.contains(where: { label($0) == id }) else { return false }
        let marker: String
        switch tab {
        case "overview": marker = "Recent Activity"
        case "work": marker = "Fixture summary for \(id)"
        case "validation": marker = "Validation passed"
        case "readiness": marker = "Fixture readiness"
        case "evidence": marker = "Proof of Work"
        case "diff": marker = "fixture.txt"
        case "logs": marker = "Fixture event"
        default: return false
        }
        return current.contains { label($0).contains(marker)
            || (value($0, "accessibilityValue") as? String ?? "").contains(marker) }
    }
    func transition(tab: String?, podID: String) async throws -> Double {
        layout()
        let node: NSObject
        if let tab { node = try #require(find(id: "detail-tab-\(tab)")) }
        else { node = try #require(find(label: "Fixture pod \(podID)")) }
        let clock = ContinuousClock()
        let start = clock.now
        press(node)
        try await wait { self.inputs.selectedID == podID && self.destination(tab ?? "overview") }
        let duration = start.duration(to: clock.now).components
        return Double(duration.attoseconds) / 1e15 + Double(duration.seconds) * 1_000
    }
}
