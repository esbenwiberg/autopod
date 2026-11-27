import SwiftUI

/// Available independently of lifecycle, recovery eligibility and archive visibility.
struct OperatorDisposalControls: View {
    let pod: Pod
    let actions: PodActions
    @State private var confirmDelete = false
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Button("Kill") { Task { await actions.kill(pod.id) } }
                    .help("Request stop and retain files. Completion requires independent confirmation.")
                Button("Delete…", role: .destructive) { confirmDelete = true }
            }
            if let receipt = pod.operatorDisposal {
                Text("History/Recovery · \(receipt.intent.capitalized) · \(receipt.state)")
                    .font(.caption).textSelection(.enabled)
                Text("Request \(receipt.requestKey) · generation \(receipt.generation)").font(.caption)
                ForEach(Array((receipt.resources ?? []).enumerated()), id: \.offset) { _, resource in
                    Text("\(resource.kind) \(resource.id) · \(resource.observedAbsent ? "confirmed absent" : resource.observedStopped ? "confirmed stopped" : "cleanup pending")")
                        .font(.caption).textSelection(.enabled)
                }
                ForEach(Array(receipt.diagnostics.enumerated()), id: \.offset) { _, diagnostic in
                    Text(diagnostic).font(.caption).textSelection(.enabled)
                }
            }
        }
        .confirmationDialog("Permanently discard unpublished resources for \(pod.id)?", isPresented: $confirmDelete, titleVisibility: .visible) {
            Button("Acknowledge data loss and request Delete", role: .destructive) {
                Task { await actions.delete(pod.id) }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Delete requests stop and permanent discard of this exact pod’s unpublished files and resources. History remains. Acceptance clears attention immediately; unknown or partial cleanup remains pending. Already admitted external effects require reconciliation.")
        }
    }
}
