import SwiftUI

/// Sales pitch page — sells the vision of Autopod with outcome-focused cards and diagrams.
public struct SalesPitchView: View {
    @State private var hoveredCard: String?

    public init() {}

    public var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 28) {
                hero
                statsRow
                problemBanner
                sellingPointsGrid
                pipelineFlow
                teamShowcase
            }
            .padding(28)
        }
        .background(Color(nsColor: .windowBackgroundColor))
    }

    // MARK: - Hero

    private var hero: some View {
        VStack(alignment: .leading, spacing: 12) {
            Image(systemName: "bolt.fill")
                .font(.system(size: 32))
                .foregroundStyle(
                    .linearGradient(
                        colors: [.blue, .purple],
                        startPoint: .topLeading,
                        endPoint: .bottomTrailing
                    )
                )

            Text("Ship code while you sleep.")
                .font(.largeTitle.weight(.bold))

            Text("From task description to merged PR — fully autonomous, fully validated, fully under your control.")
                .font(.title3)
                .foregroundStyle(.secondary)
                .lineSpacing(3)
        }
    }

    // MARK: - Stats row

    private var statsRow: some View {
        HStack(spacing: 14) {
            statCard(number: "13", label: "States in the\nsession lifecycle", color: .blue)
            statCard(number: "7", label: "Validation phases\nbefore merge", color: .green)
            statCard(number: "3", label: "AI runtimes\nplug & play", color: .cyan)
            statCard(number: "5", label: "Security layers\nper container", color: .red)
        }
    }

    private func statCard(number: String, label: String, color: Color) -> some View {
        VStack(spacing: 6) {
            Text(number)
                .font(.system(size: 36, weight: .bold, design: .rounded))
                .foregroundStyle(color)
            Text(label)
                .font(.caption)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .lineSpacing(2)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 18)
        .padding(.horizontal, 12)
        .background(Color(nsColor: .controlBackgroundColor))
        .clipShape(RoundedRectangle(cornerRadius: 10))
    }

    // MARK: - Problem banner

    private var problemBanner: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .font(.system(size: 16))
                    .foregroundStyle(.red)
                Text("The Problem")
                    .font(.headline)
            }

            Text("AI agents are powerful.\nUnsupervised AI agents are dangerous.")
                .font(.title3.weight(.semibold))
                .lineSpacing(2)

            Text("An agent with unchecked network access, no output validation, and no audit trail isn't a productivity tool — it's a liability. Autopod wraps autonomous coding in the guardrails that make it safe for real teams.")
                .font(.callout)
                .foregroundStyle(.secondary)
                .lineSpacing(3)
        }
        .padding(18)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.red.opacity(0.04))
        .overlay(
            RoundedRectangle(cornerRadius: 10)
                .stroke(Color.red.opacity(0.15), lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: 10))
    }

    // MARK: - Selling points grid

    private var sellingPointsGrid: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Why Autopod")
                .font(.title2.weight(.bold))

            LazyVGrid(
                columns: [GridItem(.adaptive(minimum: 280), spacing: 14)],
                alignment: .leading,
                spacing: 14
            ) {
                ForEach(sellingPoints, id: \.title) { point in
                    sellingPointCard(point)
                }
            }
        }
    }

    private func sellingPointCard(_ point: SellingPoint) -> some View {
        let isHovered = hoveredCard == point.title

        return VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Image(systemName: point.icon)
                    .font(.system(size: 16))
                    .foregroundStyle(point.color)
                    .frame(width: 28, height: 28)
                    .background(point.color.opacity(0.12))
                    .clipShape(RoundedRectangle(cornerRadius: 6))

                Text(point.title)
                    .font(.headline)
            }

            Text(point.body)
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineSpacing(2)
                .fixedSize(horizontal: false, vertical: true)

            Divider()

            FeatureFlowLayout(spacing: 6) {
                ForEach(point.tags, id: \.self) { tag in
                    Text(tag)
                        .font(.system(.caption2).weight(.medium))
                        .padding(.horizontal, 7)
                        .padding(.vertical, 3)
                        .background(point.color.opacity(0.08))
                        .foregroundStyle(point.color)
                        .clipShape(Capsule())
                }
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(nsColor: .controlBackgroundColor))
        .clipShape(RoundedRectangle(cornerRadius: 10))
        .shadow(
            color: .black.opacity(isHovered ? 0.08 : 0.02),
            radius: isHovered ? 8 : 3
        )
        .overlay(
            RoundedRectangle(cornerRadius: 10)
                .stroke(
                    isHovered ? point.color.opacity(0.35) : .clear,
                    lineWidth: 1.5
                )
        )
        .scaleEffect(isHovered ? 1.01 : 1.0)
        .animation(.easeOut(duration: 0.15), value: isHovered)
        .onHover { hovering in hoveredCard = hovering ? point.title : nil }
    }

    // MARK: - Pipeline flow

    private var pipelineFlow: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("From idea to PR in one command")
                .font(.title3.weight(.semibold))

            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 0) {
                    ForEach(Array(pipelineSteps.enumerated()), id: \.offset) { index, step in
                        HStack(spacing: 0) {
                            pipelineStep(step.icon, step.title, step.subtitle, step.color)
                            if index < pipelineSteps.count - 1 {
                                Image(systemName: "chevron.right")
                                    .font(.system(size: 10, weight: .semibold))
                                    .foregroundStyle(.tertiary)
                                    .padding(.horizontal, 8)
                            }
                        }
                    }
                }
                .padding(.vertical, 4)
            }

            Text("Every step is automated. Every transition is validated. You review only what passes.")
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineSpacing(2)
        }
        .padding(16)
        .background(Color(nsColor: .controlBackgroundColor))
        .clipShape(RoundedRectangle(cornerRadius: 10))
    }

    private func pipelineStep(_ icon: String, _ title: String, _ subtitle: String, _ color: Color) -> some View {
        VStack(spacing: 6) {
            Image(systemName: icon)
                .font(.system(size: 14))
                .foregroundStyle(color)
                .frame(width: 34, height: 34)
                .background(color.opacity(0.1))
                .clipShape(Circle())
            Text(title)
                .font(.system(.caption).weight(.semibold))
            Text(subtitle)
                .font(.caption2)
                .foregroundStyle(.tertiary)
        }
        .frame(width: 80)
    }

    // MARK: - Team showcase

    private var teamShowcase: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("One platform, every stack")
                .font(.title3.weight(.semibold))

            HStack(spacing: 14) {
                profileCard(
                    stack: "Node.js",
                    runtime: "Claude",
                    network: "allow-all",
                    output: "PR",
                    color: .green
                )
                profileCard(
                    stack: ".NET",
                    runtime: "Codex",
                    network: "restricted",
                    output: "PR",
                    color: .purple
                )
                profileCard(
                    stack: "Python",
                    runtime: "Copilot",
                    network: "deny-all",
                    output: "Artifact",
                    color: .orange
                )
            }

            Text("Profile inheritance means zero config duplication. Define a base, override per-team.")
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineSpacing(2)
        }
        .padding(16)
        .background(Color(nsColor: .controlBackgroundColor))
        .clipShape(RoundedRectangle(cornerRadius: 10))
    }

    private func profileCard(stack: String, runtime: String, network: String, output: String, color: Color) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(stack)
                .font(.system(.callout, design: .monospaced).weight(.semibold))

            VStack(alignment: .leading, spacing: 4) {
                profileRow(icon: "cpu", label: runtime)
                profileRow(icon: "network", label: network)
                profileRow(icon: "arrow.right.doc.on.clipboard", label: output)
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(color.opacity(0.04))
        .overlay(
            RoundedRectangle(cornerRadius: 8)
                .stroke(color.opacity(0.15), lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: 8))
    }

    private func profileRow(icon: String, label: String) -> some View {
        HStack(spacing: 6) {
            Image(systemName: icon)
                .font(.system(size: 10))
                .foregroundStyle(.secondary)
                .frame(width: 14)
            Text(label)
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    // MARK: - Data

    private var sellingPoints: [SellingPoint] {
        [
            SellingPoint(
                icon: "lock.shield",
                color: .red,
                title: "Isolation by Default",
                body: "Every session runs in its own container on an isolated network. Per-pod iptables firewall. Non-root user. No shared state between sessions — ever.",
                tags: ["iptables", "Net Isolation", "Non-root"]
            ),
            SellingPoint(
                icon: "checkmark.shield.fill",
                color: .green,
                title: "Trust Nothing, Verify Everything",
                body: "7-phase validation pipeline: build, test, health check, Playwright smoke, acceptance criteria, AI review — then human approval gates the merge.",
                tags: ["Playwright", "LLM Review", "Auto-Retry"]
            ),
            SellingPoint(
                icon: "eye.fill",
                color: .teal,
                title: "Full Visibility",
                body: "Watch agents think in real time. Every tool call, file change, and decision streamed to your desktop. 30-day event replay if you miss anything.",
                tags: ["WebSocket", "Live Events", "30d Replay"]
            ),
            SellingPoint(
                icon: "cpu",
                color: .cyan,
                title: "Any Model, One Pipeline",
                body: "Claude, Codex, Copilot — swap runtimes per profile without changing anything else. Same orchestration, same validation, same audit trail.",
                tags: ["Claude", "Codex", "Copilot"]
            ),
            SellingPoint(
                icon: "bubble.left.and.exclamationmark.bubble.right",
                color: .orange,
                title: "Humans Stay in the Loop",
                body: "Agents ask when stuck. Report plans before coding. Escalate blockers. Auto-pause when confused. You approve before anything merges.",
                tags: ["ask_human", "MCP Tools", "Auto-pause"]
            ),
            SellingPoint(
                icon: "bolt.shield.fill",
                color: .purple,
                title: "Defense in Depth",
                body: "PII scanning on all output. Prompt injection detection with threat scoring. AES-256 credential encryption. Full audit trail on every action.",
                tags: ["PII Scan", "Injection Detect", "AES-256", "Audit"]
            ),
        ]
    }

    private var pipelineSteps: [(icon: String, title: String, subtitle: String, color: Color)] {
        [
            ("text.cursor", "Describe", "Your task", .gray),
            ("shippingbox", "Provision", "Container spins up", .blue),
            ("brain.head.profile", "Code", "Agent works", .purple),
            ("testtube.2", "Validate", "7-phase pipeline", .cyan),
            ("person.fill.checkmark", "Review", "Human approval", .orange),
            ("arrow.triangle.merge", "Merge", "PR created", .indigo),
            ("checkmark.circle.fill", "Done", "Branch merged", .green),
        ]
    }
}

// MARK: - Selling point model

private struct SellingPoint {
    let icon: String
    let color: Color
    let title: String
    let body: String
    let tags: [String]
}

// MARK: - Preview

#Preview("Sales Pitch") {
    SalesPitchView()
        .frame(width: 900, height: 900)
}
