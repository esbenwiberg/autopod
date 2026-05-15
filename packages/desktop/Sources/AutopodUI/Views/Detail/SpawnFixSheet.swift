import SwiftUI
import AutopodClient

/// Sheet for spawning a fix pod with optional reviewer instructions.
/// Decodes `SpawnFixResponse` and shows a brief toast on success or an
/// inline error alert when the parent pod is in a terminal state.
struct SpawnFixSheet: View {
    let podId: String
    @Binding var message: String
    @Binding var isPresented: Bool
    /// Async callback — returns SpawnFixResponse (or nil on network failure).
    let onSpawn: (String) async -> SpawnFixResponse?

    @State private var isLoading = false
    @State private var toastText: String?
    @State private var errorText: String?
    @State private var showError = false

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Spawn Fix Pod")
                .font(.headline)

            Text("Paste reviewer comments or instructions for the fix pod. Leave blank to auto-detect CI failures and review comments from the PR.")
                .font(.subheadline)
                .foregroundStyle(.secondary)

            TextEditor(text: $message)
                .font(.body)
                .frame(minHeight: 120)
                .overlay(
                    RoundedRectangle(cornerRadius: 6)
                        .stroke(Color.secondary.opacity(0.3), lineWidth: 1)
                )
                .disabled(isLoading)

            HStack {
                Spacer()
                Button("Cancel") {
                    isPresented = false
                }
                .keyboardShortcut(.escape)
                .disabled(isLoading)
                Button(isLoading ? "Spawning…" : "Spawn Fix Pod") {
                    Task { await submit() }
                }
                .keyboardShortcut(.return)
                .buttonStyle(.borderedProminent)
                .disabled(isLoading)
            }
        }
        .padding(20)
        .frame(minWidth: 400, idealWidth: 480)
        .overlay(alignment: .top) {
            if let toast = toastText {
                Text(toast)
                    .font(.caption.weight(.medium))
                    .foregroundStyle(.white)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 7)
                    .background(Color.green.opacity(0.9), in: Capsule())
                    .padding(.top, 8)
                    .transition(.move(edge: .top).combined(with: .opacity))
            }
        }
        .animation(.easeInOut(duration: 0.2), value: toastText)
        .alert("Cannot Spawn Fix", isPresented: $showError, presenting: errorText) { _ in
            Button("OK") { errorText = nil }
        } message: { msg in
            Text(msg)
        }
    }

    @MainActor
    private func submit() async {
        isLoading = true
        let response = await onSpawn(message)

        guard let response else {
            // network error already surfaced via ActionHandler.lastError
            isPresented = false
            return
        }

        if response.ok {
            // queueLength is the count of unread feedback messages buffered for
            // the fix pod — NOT a queue position. A backlog >1 means an earlier
            // run hasn't drained yet; the fix pod will pick them all up on its
            // next run.
            let backlog = response.queueLength ?? 1
            toastText = backlog > 1
                ? "Queued · backlog \(backlog) message\(backlog == 1 ? "" : "s")"
                : "Queued for fix pod"
            try? await Task.sleep(nanoseconds: 900_000_000)
            isPresented = false
        } else if response.reason == "parent_terminal" {
            errorText = "This pod is in a terminal state and cannot accept fix requests."
            showError = true
            isLoading = false
        } else {
            isPresented = false
        }
    }
}
