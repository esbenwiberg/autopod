// Offline screenshot host for the real desktop components. Not an application target.
// See assets/readme/README.md. This file replaces the entry point only in a temporary copy.
import AppKit
import AutopodClient
import AutopodDesktop
import AutopodUI
import SwiftUI

@main
@MainActor
struct ReadmeCapture {
  static func main() {
    let app = NSApplication.shared
    app.setActivationPolicy(.accessory)
    app.finishLaunching()
    app.accessibilitySetValue(true,
      forAttribute: NSAccessibility.Attribute(rawValue: "AXEnhancedUserInterface"))
    Task { @MainActor in
      do {
        try await capture()
        exit(0)
      } catch {
        fputs("README capture failed: \(error)\n", stderr)
        exit(1)
      }
    }
    app.run()
  }

  static func value(_ node: NSObject, _ key: String) -> Any? {
    let alternate = "is" + key.prefix(1).uppercased() + key.dropFirst()
    guard node.responds(to: NSSelectorFromString(key))
      || node.responds(to: NSSelectorFromString(alternate)) else { return nil }
    return node.value(forKey: key)
  }

  static func descendants(_ node: NSObject) -> [NSObject] {
    [node] + (value(node, "accessibilityChildren") as? [NSObject] ?? []).flatMap(descendants)
  }

  static func capture() async throws {
    guard let output = ProcessInfo.processInfo.environment["AUTOPOD_README_OUTPUT"] else {
      throw NSError(domain: "ReadmeCapture", code: 1,
        userInfo: [NSLocalizedDescriptionKey: "Set AUTOPOD_README_OUTPUT"])
    }
    let defaults = UserDefaults.standard
    defaults.set(true, forKey: "autopod.desktop.redesign")
    defaults.set("dark", forKey: "autopod.desktop.appearance")
    let width = 1560.0, height = 940.0
    let host = NSHostingView(rootView: DesktopDesignPreview()
      .environment(\.desktopRedesign, true)
      .environment(\.controlActiveState, .key)
      .transaction { $0.disablesAnimations = true }
      .frame(width: width, height: height))
    host.sizingOptions = []
    host.appearance = NSAppearance(named: .darkAqua)
    let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: width, height: height),
      styleMask: [.titled], backing: .buffered, defer: false)
    window.isReleasedWhenClosed = false
    window.contentView = host
    window.orderFront(nil)
    try FileManager.default.createDirectory(atPath: output, withIntermediateDirectories: true)

    func settle() async throws {
      try await Task.sleep(for: .milliseconds(1200))
      window.layoutIfNeeded()
      host.layoutSubtreeIfNeeded()
    }
    func save(_ name: String) throws {
      guard let bitmap = host.bitmapImageRepForCachingDisplay(in: host.bounds) else {
        throw NSError(domain: "ReadmeCapture", code: 2)
      }
      host.cacheDisplay(in: host.bounds, to: bitmap)
      guard let png = bitmap.representation(using: .png, properties: [:]) else {
        throw NSError(domain: "ReadmeCapture", code: 3)
      }
      try png.write(to: URL(fileURLWithPath: output).appendingPathComponent(name + ".png"))
      print("Captured \(name): \(bitmap.pixelsWide)×\(bitmap.pixelsHigh)")
    }
    func pressTab(_ id: String) throws {
      guard let node = descendants(host).first(where: {
        value($0, "accessibilityIdentifier") as? String == "detail-tab-\(id)"
          && $0.responds(to: NSSelectorFromString("accessibilityPerformPress"))
      }), value(node, "accessibilityPerformPress") as? Bool == true else {
        let labels = descendants(host).compactMap { value($0, "accessibilityLabel") as? String }
        print("Available controls: \(labels)")
        throw NSError(domain: "ReadmeCapture", code: 4,
          userInfo: [NSLocalizedDescriptionKey: "Tab not available: \(id)"])
      }
    }

    try await settle()
    try pressTab("overview")
    try await settle()
    try save("desktop")
    for tab in ["work", "readiness", "diff"] {
      try pressTab(tab)
      try await settle()
      try save(tab)
    }
    window.contentView = nil
    window.close()
  }
}
