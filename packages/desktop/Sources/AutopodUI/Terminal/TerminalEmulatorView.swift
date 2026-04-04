import AppKit
import SwiftTerm
import SwiftUI

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

  public func makeNSView(context: Context) -> TerminalView {
    let tv = TerminalView(frame: .zero)
    Self.applyTheme(tv)
    tv.terminalDelegate = context.coordinator

    // Register to receive data from the pipe
    dataPipe.setReceiver { bytes in
      tv.feed(byteArray: ArraySlice(bytes))
    }

    // Report initial size once SwiftTerm has a real frame (not .zero).
    // The view isn't laid out yet inside makeNSView, so getDims() returns
    // garbage (e.g. cols=-2). Wait for the first sizeChanged delegate call instead.

    return tv
  }

  // MARK: - Theme

  private static func applyTheme(_ tv: TerminalView) {
    // Dark terminal with warm tones (Catppuccin Mocha-inspired)
    tv.nativeBackgroundColor = NSColor(red: 0.12, green: 0.12, blue: 0.18, alpha: 1) // #1e1e2e
    tv.nativeForegroundColor = NSColor(red: 0.80, green: 0.81, blue: 0.89, alpha: 1) // #cdd6f4
    tv.caretColor = NSColor(red: 0.95, green: 0.55, blue: 0.66, alpha: 1)            // #f38ba8
    tv.caretTextColor = NSColor(red: 0.12, green: 0.12, blue: 0.18, alpha: 1)        // match bg

    // Font — SF Mono at a comfortable size with relaxed line spacing
    tv.font = NSFont.monospacedSystemFont(ofSize: 14, weight: .regular)
  }

  public func updateNSView(_ tv: TerminalView, context: Context) {
    context.coordinator.onSendData = onSendData
    context.coordinator.onResize = onResize
  }

  public static func dismantleNSView(_ tv: TerminalView, coordinator: Coordinator) {
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
