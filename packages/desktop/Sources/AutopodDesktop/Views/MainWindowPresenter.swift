import AppKit
import SwiftUI

public extension Notification.Name {
  static let autopodShowMainWindow = Notification.Name("com.autopod.desktop.showMainWindow")
}

public struct MainWindowOpenTrigger: View {
  @Environment(\.openWindow) private var openWindow

  public init() {}

  public var body: some View {
    Color.clear
      .frame(width: 0, height: 0)
      .onAppear(perform: openMainWindow)
      .onReceive(NotificationCenter.default.publisher(for: .autopodShowMainWindow)) { _ in
        openMainWindow()
      }
  }

  private func openMainWindow() {
    DispatchQueue.main.async {
      openWindow(id: "main")
    }
  }
}

/// Keeps the SwiftUI main window visible when macOS restores only auxiliary scenes.
public struct MainWindowPresenter: NSViewRepresentable {
  public init() {}

  public func makeNSView(context: Context) -> NSView {
    let view = NSView(frame: .zero)
    presentWindow(from: view)
    return view
  }

  public func updateNSView(_ nsView: NSView, context: Context) {
    presentWindow(from: nsView)
  }

  private func presentWindow(from view: NSView, attempt: Int = 0) {
    DispatchQueue.main.async {
      guard let window = view.window else {
        if attempt < 5 {
          DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
            presentWindow(from: view, attempt: attempt + 1)
          }
        }
        return
      }

      NSApp.setActivationPolicy(.regular)
      window.title = "Autopod"
      window.isReleasedWhenClosed = false
      window.isRestorable = false
      window.styleMask.insert([.titled, .closable, .miniaturizable, .resizable])

      if window.frame.width < 800 || window.frame.height < 500 {
        window.setContentSize(NSSize(width: 1200, height: 700))
        window.center()
      }

      NSApp.unhide(nil)
      NSApp.activate(ignoringOtherApps: true)
      window.orderFrontRegardless()
      window.makeKeyAndOrderFront(nil)
    }
  }
}
