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
  public let palette: DesktopPaletteColors

  public init(
    dataPipe: TerminalDataPipe,
    onSendData: @escaping ([UInt8]) -> Void,
    onResize: @escaping (Int, Int) -> Void,
    palette: DesktopPaletteColors = DesktopThemeChoice.rex.colors(dark: true)
  ) {
    self.dataPipe = dataPipe
    self.onSendData = onSendData
    self.onResize = onResize
    self.palette = palette
  }

  public func makeNSView(context: Context) -> TerminalScrollInterceptor {
    let tv = TerminalView(frame: .zero)
    Self.applyTheme(tv, palette: palette)
    context.coordinator.appliedPalette = palette
    tv.font = NSFont.monospacedSystemFont(ofSize: 14, weight: .regular)
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

  static func applyTheme(_ tv: TerminalView, palette: DesktopPaletteColors) {
    tv.nativeBackgroundColor = DesktopPaletteColors.native(palette.canvas)
    tv.nativeForegroundColor = DesktopPaletteColors.native(palette.text)
    tv.caretColor = DesktopPaletteColors.native(palette.accent)
    tv.caretTextColor = DesktopPaletteColors.native(palette.canvas)
    tv.selectedTextBackgroundColor = DesktopPaletteColors.native(palette.selection)
    tv.installColors(palette.ansi.map { hex in
      SwiftTerm.Color(red: UInt16((hex >> 16) & 255) * 257,
                      green: UInt16((hex >> 8) & 255) * 257,
                      blue: UInt16(hex & 255) * 257)
    })
    tv.needsDisplay = true
  }

  public func updateNSView(_ wrapper: TerminalScrollInterceptor, context: Context) {
    context.coordinator.onSendData = onSendData
    context.coordinator.onResize = onResize
    if context.coordinator.appliedPalette != palette {
      Self.applyTheme(wrapper.terminalView, palette: palette)
      context.coordinator.appliedPalette = palette
    }
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
    var appliedPalette: DesktopPaletteColors?
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
