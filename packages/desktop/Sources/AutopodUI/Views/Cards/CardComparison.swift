import SwiftUI

/// Side-by-side comparison of all three card designs
struct CardComparison: View {
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 32) {
                comparisonRow("Awaiting Input", session: MockData.awaitingInput)
                comparisonRow("Validated", session: MockData.validated)
                comparisonRow("Running", session: MockData.running)
                comparisonRow("Failed", session: MockData.failed)
            }
            .padding(24)
        }
        .background(Color(nsColor: .windowBackgroundColor))
    }

    private func comparisonRow(_ title: String, session: Session) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(title.uppercased())
                .font(.system(.caption, design: .default).weight(.bold))
                .foregroundStyle(.tertiary)
                .tracking(1)
            HStack(alignment: .top, spacing: 20) {
                VStack(spacing: 4) {
                    SessionCard(session: session)
                    Text("A — Original").font(.caption2).foregroundStyle(.tertiary)
                }
                VStack(spacing: 4) {
                    SessionCardB(session: session)
                    Text("B — Compact").font(.caption2).foregroundStyle(.tertiary)
                }
                VStack(spacing: 4) {
                    SessionCardC(session: session)
                    Text("C — Bold").font(.caption2).foregroundStyle(.tertiary)
                }
            }
        }
    }
}

#Preview("Compare all designs") {
    CardComparison()
        .frame(width: 850, height: 900)
}
