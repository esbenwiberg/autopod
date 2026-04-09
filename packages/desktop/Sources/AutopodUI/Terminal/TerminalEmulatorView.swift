import AppKit
import SwiftTerm
import SwiftUI

/// Wrapper NSView that intercepts scroll-wheel events and forwards them
/// as xterm mouse-wheel sequences when the terminal has mouse reporting
/// enabled (e.g. tmux with `mouse on`).
///
/// AppKit delivers scroll events to the deepest view under the cursor —
/// that's the child `TerminalView`, not this parent wrapper. So overriding
/// `scrollWheel(with:)` here never fires. Instead we install a local
/// event monitor that intercepts scroll events before they reach the
/// terminal view.
public final class TerminalScrollInterceptor: NSView {
  let terminalView: TerminalView
  private nonisolated(unsafe) var scrollMonitor: Any?

  init(terminalView: TerminalView) {
    self.terminalView = terminalView
    super.init(frame: .zero)
    addSubview(terminalView)
    terminalView.translatesAutoresizingMaskIntoConstraints = false
    NSLayoutConstraint.activate([
      terminalView.topAnchor.constraint(equalTo: topAnchor),
      terminalView.bottomAnchor.constraint(equalTo: bottomAnchor),
      terminalView.leadingAnchor.constraint(equalTo: leadingAnchor),
      terminalView.trailingAnchor.constraint(equalTo: trailingAnchor),
    ])

    scrollMonitor = NSEvent.addLocalMonitorForEvents(matching: .scrollWheel) { [weak self] event in
      guard let self = self,
            event.deltaY != 0 else { return event }

      let terminal = self.terminalView.terminal!

      // Only intercept when the running app requested mouse events
      // (e.g. tmux `set -g mouse on`). We check mouseMode directly
      // because allowMouseReporting is deliberately disabled on the
      // TerminalView to preserve native text selection for clicks.
      guard terminal.mouseMode != .off else {
        return event
      }

      // Make sure the scroll is within our terminal view's bounds.
      let locationInSelf = self.convert(event.locationInWindow, from: nil)
      guard self.bounds.contains(locationInSelf) else {
        return event
      }

      let lines = Self.scrollVelocity(delta: Int(abs(event.deltaY)))
      // Xterm mouse wheel: button flag 64 = scroll up, 65 = scroll down
      let buttonFlags = event.deltaY > 0 ? 64 : 65
      for _ in 0..<lines {
        terminal.sendEvent(buttonFlags: buttonFlags, x: 0, y: 0)
      }
      return nil // consumed — don't let SwiftTerm also handle it
    }
  }

  deinit {
    if let monitor = scrollMonitor {
      NSEvent.removeMonitor(monitor)
    }
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  private static func scrollVelocity(delta: Int) -> Int {
    if delta > 9 { return 20 }
    if delta > 5 { return 10 }
    if delta > 1 { return 3 }
    return 1
  }
}

/// NSViewRepresentable wrapper around SwiftTerm's `TerminalView`.
/// Provides a real xterm-compatible terminal emulator with proper ANSI rendering,
/// text selection, scrollback, colors — the whole deal.
public struct TerminalEmulatorView: NSViewRepresentable {

  /// Pipe that feeds raw bytes from the WebSocket into the terminal.
  public let dataPipe: TerminalDataPipe

  /// Called when the user types — bytes should be sent to the WebSocket stdin.
  public let onSendData: ([UInt8]) -> Void

  /// Called when the terminal view resizes — send resize control frame.
  public let onResize: (Int, Int) -> Void

  public init(
    dataPipe: TerminalDataPipe,
    onSendData: @escaping ([UInt8]) -> Void,
    onResize: @escaping (Int, Int) -> Void
  ) {
    self.dataPipe = dataPipe
    self.onSendData = onSendData
    self.onResize = onResize
  }

  public func makeNSView(context: Context) -> TerminalScrollInterceptor {
    let tv = TerminalView(frame: .zero)
    Self.applyTheme(tv)
    tv.terminalDelegate = context.coordinator

    // Disable SwiftTerm's built-in mouse reporting so click/drag events
    // stay local (native text selection) instead of being sent to the app
    // (tmux). Our scroll monitor handles mouse-wheel separately by checking
    // terminal.mouseMode directly.
    tv.allowMouseReporting = false

    // Register to receive data from the pipe
    dataPipe.setReceiver { bytes in
      tv.feed(byteArray: ArraySlice(bytes))
    }

    // Report initial size once SwiftTerm has a real frame (not .zero).
    // The view isn't laid out yet inside makeNSView, so getDims() returns
    // garbage (e.g. cols=-2). Wait for the first sizeChanged delegate call instead.

    return TerminalScrollInterceptor(terminalView: tv)
  }

  // MARK: - Theme

  /// Convert 8-bit RGB to SwiftTerm's 16-bit Color.
  private static func c(_ r: UInt16, _ g: UInt16, _ b: UInt16) -> SwiftTerm.Color {
    SwiftTerm.Color(red: r * 257, green: g * 257, blue: b * 257)
  }

  private static func applyTheme(_ tv: TerminalView) {
    // Dark terminal with warm tones (Catppuccin Mocha)
    tv.nativeBackgroundColor = NSColor(red: 0.12, green: 0.12, blue: 0.18, alpha: 1) // #1e1e2e
    tv.nativeForegroundColor = NSColor(red: 0.80, green: 0.81, blue: 0.89, alpha: 1) // #cdd6f4
    tv.caretColor = NSColor(red: 0.95, green: 0.55, blue: 0.66, alpha: 1)            // #f38ba8
    tv.caretTextColor = NSColor(red: 0.12, green: 0.12, blue: 0.18, alpha: 1)        // match bg

    // Install Catppuccin Mocha ANSI palette — without this, shells using ANSI color
    // codes (prompts, ls, tmux) hit SwiftTerm's default VGA palette where dark colors
    // are invisible against our dark background.
    tv.installColors([
      c(0x45, 0x47, 0x5A), // 0  black   (surface1 — visible on #1e1e2e)
      c(0xF3, 0x8B, 0xA8), // 1  red
      c(0xA6, 0xE3, 0xA1), // 2  green
      c(0xF9, 0xE2, 0xAF), // 3  yellow
      c(0x89, 0xB4, 0xFA), // 4  blue
      c(0xF5, 0xC2, 0xE7), // 5  magenta  (pink)
      c(0x94, 0xE2, 0xD5), // 6  cyan     (teal)
      c(0xBA, 0xC2, 0xDE), // 7  white    (subtext1)
      c(0x58, 0x5B, 0x70), // 8  bright black  (surface2)
      c(0xF3, 0x8B, 0xA8), // 9  bright red
      c(0xA6, 0xE3, 0xA1), // 10 bright green
      c(0xF9, 0xE2, 0xAF), // 11 bright yellow
      c(0x89, 0xB4, 0xFA), // 12 bright blue
      c(0xF5, 0xC2, 0xE7), // 13 bright magenta
      c(0x94, 0xE2, 0xD5), // 14 bright cyan
      c(0xCD, 0xD6, 0xF4), // 15 bright white  (text)
    ])

    // Font — SF Mono at a comfortable size with relaxed line spacing
    tv.font = NSFont.monospacedSystemFont(ofSize: 14, weight: .regular)
  }

  public func updateNSView(_ wrapper: TerminalScrollInterceptor, context: Context) {
    context.coordinator.onSendData = onSendData
    context.coordinator.onResize = onResize
  }

  public static func dismantleNSView(_ wrapper: TerminalScrollInterceptor, coordinator: Coordinator) {
    coordinator.dataPipe.clearReceiver()
  }

  public func makeCoordinator() -> Coordinator {
    Coordinator(dataPipe: dataPipe, onSendData: onSendData, onResize: onResize)
  }

  // MARK: - Coordinator (TerminalViewDelegate)

  public final class Coordinator: NSObject, TerminalViewDelegate {
    let dataPipe: TerminalDataPipe
    var onSendData: ([UInt8]) -> Void
    var onResize: (Int, Int) -> Void

    init(
      dataPipe: TerminalDataPipe,
      onSendData: @escaping ([UInt8]) -> Void,
      onResize: @escaping (Int, Int) -> Void
    ) {
      self.dataPipe = dataPipe
      self.onSendData = onSendData
      self.onResize = onResize
    }

    public func send(source: TerminalView, data: ArraySlice<UInt8>) {
      onSendData(Array(data))
    }

    public func sizeChanged(source: TerminalView, newCols: Int, newRows: Int) {
      onResize(newCols, newRows)
    }

    public func setTerminalTitle(source: TerminalView, title: String) {}

    public func scrolled(source: TerminalView, position: Double) {}

    public func hostCurrentDirectoryUpdate(source: TerminalView, directory: String?) {}

    public func rangeChanged(source: TerminalView, startY: Int, endY: Int) {}

    public func clipboardCopy(source: TerminalView, content: Data) {
      NSPasteboard.general.clearContents()
      NSPasteboard.general.setData(content, forType: .string)
    }
  }
}
