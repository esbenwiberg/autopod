import Foundation

/// Bridges raw terminal data from a WebSocket source to a SwiftTerm view.
/// Decouples the networking layer (AutopodClient/AutopodDesktop) from the
/// terminal rendering layer (AutopodUI) without either needing to know about the other.
///
/// Buffers data that arrives before the SwiftTerm view is ready, then flushes
/// on receiver registration so the initial prompt is never lost.
@MainActor
public final class TerminalDataPipe: @unchecked Sendable {

  private var receiver: (([UInt8]) -> Void)?
  private var buffer: [[UInt8]] = []

  public init() {}

  /// Called by the terminal emulator view to register itself as the data receiver.
  /// Flushes any buffered data that arrived before the view was ready.
  public func setReceiver(_ handler: @escaping ([UInt8]) -> Void) {
    receiver = handler
    for chunk in buffer {
      handler(chunk)
    }
    buffer.removeAll()
  }

  /// Called by the socket/manager layer to push raw bytes into the terminal.
  public func feed(_ data: Data) {
    let bytes = [UInt8](data)
    if let receiver {
      receiver(bytes)
    } else {
      buffer.append(bytes)
    }
  }

  /// Clears the receiver (e.g. when the view disappears).
  public func clearReceiver() {
    receiver = nil
  }
}
