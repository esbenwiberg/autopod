import SwiftUI
import AutopodClient

/// First-launch sheet for adding a daemon connection.
struct SetupSheet: View {
  @Binding var isPresented: Bool
  let connectionManager: ConnectionManager

  @State private var name = "Local"
  @State private var urlString = "http://localhost:3000"
  @State private var token = ""
  @State private var isTesting = false
  @State private var isSaving = false
  @State private var testResult: TestResult?

  private enum TestResult: Equatable {
    case success
    case failure(String)
  }

  private var canTest: Bool {
    !urlString.isEmpty && !token.isEmpty && URL(string: urlString) != nil
  }

  private var canSave: Bool {
    canTest && testResult == .success
  }

  var body: some View {
    VStack(spacing: 0) {
      // Header
      VStack(spacing: 6) {
        Image(systemName: "server.rack")
          .font(.system(size: 32))
          .foregroundStyle(.blue)
        Text("Connect to Daemon")
          .font(.headline)
        Text("Enter the URL and token for your Autopod daemon.")
          .font(.caption)
          .foregroundStyle(.secondary)
      }
      .padding(.top, 24)
      .padding(.bottom, 16)

      Divider()

      // Form
      VStack(alignment: .leading, spacing: 16) {
        field("Name") {
          TextField("Local", text: $name)
            .textFieldStyle(.roundedBorder)
        }

        field("Daemon URL") {
          TextField("http://localhost:3000", text: $urlString)
            .textFieldStyle(.roundedBorder)
            .font(.system(.callout, design: .monospaced))
        }

        field("Auth Token") {
          SecureField("Bearer token", text: $token)
            .textFieldStyle(.roundedBorder)
            .font(.system(.callout, design: .monospaced))
        }

        // Test connection button
        HStack {
          Button {
            Task { await testConnection() }
          } label: {
            HStack(spacing: 6) {
              if isTesting {
                ProgressView().scaleEffect(0.6)
              }
              Text("Test Connection")
            }
          }
          .disabled(!canTest || isTesting)

          Spacer()

          // Result indicator
          if let result = testResult {
            HStack(spacing: 4) {
              switch result {
              case .success:
                Image(systemName: "checkmark.circle.fill")
                  .foregroundStyle(.green)
                Text("Connected")
                  .foregroundStyle(.green)
              case .failure(let msg):
                Image(systemName: "xmark.circle.fill")
                  .foregroundStyle(.red)
                Text(msg)
                  .foregroundStyle(.red)
                  .lineLimit(1)
              }
            }
            .font(.caption)
          }
        }
      }
      .padding(24)

      Spacer()

      Divider()

      // Actions
      HStack {
        Spacer()
        Button("Cancel") {
          isPresented = false
        }
        .keyboardShortcut(.cancelAction)

        Button("Save & Connect") {
          Task { await saveAndConnect() }
        }
        .buttonStyle(.borderedProminent)
        .keyboardShortcut(.defaultAction)
        .disabled(!canSave || isSaving)
      }
      .padding(16)
    }
    .frame(width: 420, height: 380)
    .background(Color(nsColor: .windowBackgroundColor))
  }

  // MARK: - Helpers

  private func field<Content: View>(
    _ label: String, @ViewBuilder content: () -> Content
  ) -> some View {
    VStack(alignment: .leading, spacing: 4) {
      Text(label)
        .font(.system(.caption).weight(.semibold))
        .foregroundStyle(.secondary)
      content()
    }
  }

  private func testConnection() async {
    guard let url = URL(string: urlString) else {
      testResult = .failure("Invalid URL")
      return
    }
    isTesting = true
    testResult = nil

    let result = await connectionManager.testConnection(url: url, token: token)
    switch result {
    case .success:
      testResult = .success
    case .failure(let error):
      testResult = .failure(error.localizedDescription)
    }
    isTesting = false
  }

  private func saveAndConnect() async {
    guard let url = URL(string: urlString) else { return }
    isSaving = true
    do {
      try await connectionManager.addAndConnect(name: name, url: url, token: token)
      isPresented = false
    } catch {
      testResult = .failure(error.localizedDescription)
    }
    isSaving = false
  }
}
