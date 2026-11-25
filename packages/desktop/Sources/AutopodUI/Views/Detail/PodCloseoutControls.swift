import SwiftUI

struct ResearchFindingsAcceptance: View {
    let pod: Pod
    let actions: PodActions
    @State private var pending = false
    @State private var error: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let findings = pod.researchFindings {
                Button(pending ? "Accepting…" : "Accept findings") {
                    pending = true
                    error = nil
                    Task {
                        defer { pending = false }
                        do { try await actions.acceptFindings(pod.id, findings) }
                        catch { self.error = error.localizedDescription }
                    }
                }
                .buttonStyle(.borderedProminent)
                .disabled(pending)
                .accessibilityIdentifier("accept-findings-\(pod.id)")
                Text("Records that you reviewed the findings. It does not mark the issue fixed or authorize implementation.")
                    .font(.caption).foregroundStyle(.secondary)
            } else {
                Text("The findings receipt isn’t available yet. Refresh the pod before accepting.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            if let error { Text(error).font(.caption).foregroundStyle(.red) }
        }
    }
}

struct FailureCloseoutControl: View {
    let pod: Pod
    let close: (@MainActor @Sendable (String, String) async throws -> Void)?
    @State private var confirm = false
    @State private var reviewedRevision: String?
    @State private var pending = false
    @State private var error: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if pod.isClosedFailure {
                Label("Closed as failed", systemImage: "checkmark.circle")
                    .font(.caption).foregroundStyle(.secondary)
            } else if let close, let revision = pod.failureRevision, !pod.isWorkspace,
                      pod.fleetArchivedAt == nil {
                Button(pending ? "Checking execution…" : "Close as failed…") {
                    reviewedRevision = revision
                    confirm = true
                }
                .buttonStyle(.bordered)
                .disabled(pending)
                .accessibilityIdentifier("close-failure-\(pod.id)")
                .confirmationDialog("Close as failed?", isPresented: $confirm, titleVisibility: .visible,
                                    presenting: reviewedRevision) { expected in
                    Button("Close as failed") {
                        pending = true
                        error = nil
                        Task {
                            defer { pending = false }
                            do { try await close(pod.id, expected) }
                            catch { self.error = error.localizedDescription }
                        }
                    }
                    Button("Cancel", role: .cancel) {}
                } message: { _ in
                    Text("If execution has stopped, the pod leaves Needs attention and Active. Its failure, logs, and saved work remain. Dependent pods stay blocked.")
                }
                if let error { Text(error).font(.caption).foregroundStyle(.red) }
            }
        }
    }
}
