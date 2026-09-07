import AutopodClient
import SwiftUI

struct CostEvidenceView: View {
    let evidence: CostEvidence?

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Stored cost subtotal; billing unverified.")
            if let evidence {
                Text("Known estimates: $\(evidence.knownEstimatedCostUsd, specifier: "%.4f") · \(evidence.unavailablePhaseCount) identified phases with unavailable cost · \(evidence.conflictingPodCount) pods with conflicting attribution")
                ForEach(evidence.diagnostics.indices, id: \.self) { index in
                    let item = evidence.diagnostics[index]
                    Text("\(item.podId): \(item.message)")
                }
                if evidence.omittedDiagnosticCount > 0 {
                    Text("\(evidence.omittedDiagnosticCount) additional diagnostics omitted.")
                }
            } else {
                Text("Cost provenance unavailable.")
            }
        }
        .font(.caption)
        .foregroundStyle(.secondary)
        .textSelection(.enabled)
    }
}
