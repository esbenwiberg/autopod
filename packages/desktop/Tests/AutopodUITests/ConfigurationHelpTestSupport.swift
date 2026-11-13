import AppKit
import Testing

/// macOS 15 will not anchor a popover to an offscreen AX button. Scroll the
/// actual document first, just as a person must, rather than pressing hidden rows.
@MainActor func revealConfigurationHelpControl(_ id: String) async throws {
  func value(_ node: NSObject, _ key: String) -> Any? {
    guard node.responds(to: NSSelectorFromString(key)) else { return nil }
    return node.value(forKey: key)
  }
  func nodes(_ root: NSObject) -> [NSObject] {
    [root] + (value(root, "accessibilityChildren") as? [NSObject] ?? []).flatMap(nodes)
  }
  func views(_ root: NSView) -> [NSView] { [root] + root.subviews.flatMap(views) }
  let window = try #require(NSApplication.shared.windows.first { window in
    guard let content = window.contentView else { return false }
    return nodes(content).contains { value($0, "accessibilityIdentifier") as? String == id }
  })
  let content = try #require(window.contentView)
  let node = try #require(nodes(content).first { value($0, "accessibilityIdentifier") as? String == id })
  let frame = try #require(value(node, "accessibilityFrame") as? NSValue).rectValue
  try #require(!frame.isEmpty, "Help control must expose a nonempty AX frame: \(id)")
  var matchedScroll = false
  // The outer form and the popover each have their own native scroll document.
  // Ignore nested text editors whose document does not contain this control.
  for scroll in views(content).compactMap({ $0 as? NSScrollView }) {
    guard let document = scroll.documentView else { continue }
    let rectangle = document.convert(window.convertFromScreen(frame), from: nil)
    guard document.bounds.contains(rectangle) else { continue }
    matchedScroll = true
    document.scrollToVisible(rectangle)
    scroll.reflectScrolledClipView(scroll.contentView)
    let viewport = window.convertToScreen(scroll.contentView.convert(scroll.contentView.bounds, to: nil))
    var visible = false
    for _ in 0..<50 {
      content.layoutSubtreeIfNeeded()
      if let current = nodes(content).first(where: { value($0, "accessibilityIdentifier") as? String == id }),
         let currentFrame = (value(current, "accessibilityFrame") as? NSValue)?.rectValue,
         viewport.insetBy(dx: -2, dy: -2).contains(currentFrame) { visible = true; break }
      try await Task.sleep(for: .milliseconds(20))
    }
    try #require(visible, "Help control must be inside its real scroll viewport before pressing: \(id)")
  }
  // Newer SwiftUI popovers can render without an AppKit scroll document.
  // They still must expose the control within the actual content window.
  try #require(matchedScroll || window.convertToScreen(content.bounds).insetBy(dx: -2, dy: -2).contains(frame),
    "Help control must be visible in a scroll viewport or its content window: \(id)")
  content.layoutSubtreeIfNeeded()
  try await Task.sleep(for: .milliseconds(50))
}
