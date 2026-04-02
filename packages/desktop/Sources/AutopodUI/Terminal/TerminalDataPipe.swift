import Foundation

/// Bridges raw terminal data from a WebSocket source to a SwiftTerm view.
/// Decouples the networking layer (AutopodClient/AutopodDesktop) from the
/// terminal rendering layer (AutopodUI) without either needing to know about the other.
@MainActor
public final class TerminalDataPipe: @unchecked Sendable {

  private var receiver: (([UInt8]) -> Void)?

  public init() {}

  /// Called by the terminal emulator view to register itself as the data receiver.
  public func setReceiver(_ handler: @escaping ([UInt8]) -> Void) {
    receiver = handler
  }

  /// Called by the socket/manager layer to push raw bytes into the terminal.
  public func feed(_ data: Data) {
    receiver?([UInt8](data))
  }

  /// Clears the receiver (e.g. when the view disappears).
  public func clearReceiver() {
    receiver = nil
  }
}
