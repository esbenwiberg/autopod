import AppKit
import SwiftUI

/// Refreshes native keyboard ownership even when a render changes only callbacks.
struct CommandPaletteKeyboardBridge: NSViewRepresentable {
  let isPresented: Bool
  let onKey: (UInt16) -> Bool

  func makeNSView(context: Context) -> CommandPaletteKeyboardView {
    CommandPaletteKeyboardView()
  }

  func updateNSView(_ view: CommandPaletteKeyboardView, context: Context) {
    view.update(isPresented: isPresented, onKey: onKey)
  }

  static func dismantleNSView(_ view: CommandPaletteKeyboardView, coordinator: ()) {
    view.dispose()
  }
}

/// A noninteractive attachment to the palette's actual window, not a global owner.
final class CommandPaletteKeyboardView: NSView {
  private var onKey: ((UInt16) -> Bool)?
  private nonisolated(unsafe) var monitor: Any?
  private weak var observedWindow: NSWindow?
  private var windowClosed = false

  // Internal read-only seam for native attachment/teardown assertions.
  var isMonitoring: Bool { monitor != nil }

  override func hitTest(_ point: NSPoint) -> NSView? { nil }

  func update(isPresented: Bool, onKey: @escaping (UInt16) -> Bool) {
    self.onKey = isPresented ? onKey : nil
    synchronizeMonitor()
  }

  override func viewDidMoveToWindow() {
    super.viewDidMoveToWindow()
    removeMonitor()
    NotificationCenter.default.removeObserver(self)
    observedWindow = window
    windowClosed = false
    if let window {
      NotificationCenter.default.addObserver(self, selector: #selector(windowWillClose),
        name: NSWindow.willCloseNotification, object: window)
      NotificationCenter.default.addObserver(self, selector: #selector(windowBecameKey),
        name: NSWindow.didBecomeKeyNotification, object: window)
      NotificationCenter.default.addObserver(self, selector: #selector(windowBecameVisible),
        name: NSWindow.didChangeOcclusionStateNotification, object: window)
      NotificationCenter.default.addObserver(self, selector: #selector(windowBecameVisible),
        name: NSWindow.didUpdateNotification, object: window)
    }
    synchronizeMonitor()
  }

  @objc private func windowWillClose(_ notification: Notification) {
    windowClosed = true
    removeMonitor()
  }

  @objc private func windowBecameKey(_ notification: Notification) {
    windowClosed = false
    synchronizeMonitor()
  }

  @objc private func windowBecameVisible(_ notification: Notification) {
    guard window?.isVisible == true else { return }
    windowClosed = false
    synchronizeMonitor()
  }

  private func synchronizeMonitor() {
    guard onKey != nil, window != nil, !windowClosed else {
      removeMonitor()
      return
    }
    guard monitor == nil else { return }
    monitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
      guard let self, let window = self.window, window === self.observedWindow,
            event.window === window, window.isVisible, !self.windowClosed,
            let onKey = self.onKey else { return event }
      switch event.keyCode {
      case 125, 126, 36, 76, 53:
        return onKey(event.keyCode) ? nil : event
      default:
        return event
      }
    }
  }

  private func removeMonitor() {
    guard let monitor else { return }
    NSEvent.removeMonitor(monitor)
    self.monitor = nil
  }

  func dispose() {
    removeMonitor()
    NotificationCenter.default.removeObserver(self)
    observedWindow = nil
    onKey = nil
  }

  deinit {
    if let monitor { NSEvent.removeMonitor(monitor) }
    NotificationCenter.default.removeObserver(self)
  }
}
