import SwiftUI

/// Detail pane shown when a feature card is selected on the Overview page.
/// Presents What / Why / How sections for the selected feature category.
public struct FeatureDetailPanelView: View {
    public let feature: FeatureCategory
    public var onSelectRelated: ((FeatureCategory) -> Void)?

    public init(feature: FeatureCategory, onSelectRelated: ((FeatureCategory) -> Void)? = nil) {
        self.feature = feature
        self.onSelectRelated = onSelectRelated
    }

    public var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    section("What", content: feature.what)
                    section("Why", content: feature.why)
                    howSection
                    if !feature.keyFiles.isEmpty {
                        keyFilesSection
                    }
                    if !feature.relatedFeatures.isEmpty {
                        relatedSection
                    }
                }
                .padding(20)
            }
        }
        .background(Color(nsColor: .windowBackgroundColor))
    }

    // MARK: - Header

    private var header: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 10) {
                Image(systemName: feature.icon)
                    .font(.system(size: 18))
                    .foregroundStyle(feature.color)
                    .frame(width: 34, height: 34)
                    .background(feature.color.opacity(0.12))
                    .clipShape(RoundedRectangle(cornerRadius: 8))

                VStack(alignment: .leading, spacing: 2) {
                    Text(feature.title)
                        .font(.headline)
                    Text(feature.subtitle)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
            }

            HStack(spacing: 6) {
                ForEach(feature.highlights, id: \.self) { tag in
                    Text(tag)
                        .font(.system(.caption2).weight(.medium))
                        .padding(.horizontal, 7)
                        .padding(.vertical, 3)
                        .background(feature.color.opacity(0.08))
                        .foregroundStyle(feature.color)
                        .clipShape(Capsule())
                }
            }
        }
        .padding(20)
    }

    // MARK: - Section

    private func section(_ title: String, content: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                RoundedRectangle(cornerRadius: 1)
                    .fill(feature.color.opacity(0.5))
                    .frame(width: 3, height: 14)
                Text(title)
                    .font(.system(.subheadline).weight(.semibold))
            }
            Text(content)
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineSpacing(3)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    // MARK: - How section (with bullets)

    private var howSection: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                RoundedRectangle(cornerRadius: 1)
                    .fill(feature.color.opacity(0.5))
                    .frame(width: 3, height: 14)
                Text("How")
                    .font(.system(.subheadline).weight(.semibold))
            }
            Text(feature.how)
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineSpacing(3)
                .fixedSize(horizontal: false, vertical: true)

            if !feature.howBullets.isEmpty {
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(feature.howBullets, id: \.self) { bullet in
                        HStack(alignment: .top, spacing: 6) {
                            Circle()
                                .fill(feature.color.opacity(0.4))
                                .frame(width: 4, height: 4)
                                .padding(.top, 5)
                            Text(bullet)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .lineSpacing(2)
                        }
                    }
                }
                .padding(.leading, 4)
            }
        }
    }

    // MARK: - Key files

    private var keyFilesSection: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Key Files")
                .font(.system(.caption).weight(.semibold))
                .foregroundStyle(.secondary)

            FeatureFlowLayout(spacing: 6) {
                ForEach(feature.keyFiles, id: \.self) { file in
                    Text(file)
                        .font(.system(.caption2, design: .monospaced))
                        .padding(.horizontal, 8)
                        .padding(.vertical, 4)
                        .background(feature.color.opacity(0.06))
                        .foregroundStyle(feature.color.opacity(0.8))
                        .clipShape(RoundedRectangle(cornerRadius: 5))
                }
            }
        }
    }

    // MARK: - Related features

    private var relatedSection: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Related")
                .font(.system(.caption).weight(.semibold))
                .foregroundStyle(.secondary)

            HStack(spacing: 8) {
                ForEach(feature.relatedFeatures) { related in
                    Button {
                        onSelectRelated?(related)
                    } label: {
                        HStack(spacing: 4) {
                            Image(systemName: related.icon)
                                .font(.system(size: 9))
                            Text(related.title)
                                .font(.caption2)
                        }
                        .padding(.horizontal, 8)
                        .padding(.vertical, 4)
                        .background(related.color.opacity(0.08))
                        .foregroundStyle(related.color)
                        .clipShape(Capsule())
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }
}

// MARK: - Flow layout for file tags

struct FeatureFlowLayout: Layout {
    var spacing: CGFloat

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let rows = computeRows(proposal: proposal, subviews: subviews)
        var height: CGFloat = 0
        for (index, row) in rows.enumerated() {
            let rowHeight = row.map { subviews[$0].sizeThatFits(.unspecified).height }.max() ?? 0
            height += rowHeight
            if index < rows.count - 1 { height += spacing }
        }
        return CGSize(width: proposal.width ?? 0, height: height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let rows = computeRows(proposal: proposal, subviews: subviews)
        var y = bounds.minY
        for row in rows {
            let rowHeight = row.map { subviews[$0].sizeThatFits(.unspecified).height }.max() ?? 0
            var x = bounds.minX
            for index in row {
                let size = subviews[index].sizeThatFits(.unspecified)
                subviews[index].place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
                x += size.width + spacing
            }
            y += rowHeight + spacing
        }
    }

    private func computeRows(proposal: ProposedViewSize, subviews: Subviews) -> [[Int]] {
        let maxWidth = proposal.width ?? .infinity
        var rows: [[Int]] = [[]]
        var currentWidth: CGFloat = 0
        for (index, subview) in subviews.enumerated() {
            let size = subview.sizeThatFits(.unspecified)
            if currentWidth + size.width > maxWidth && !rows[rows.count - 1].isEmpty {
                rows.append([])
                currentWidth = 0
            }
            rows[rows.count - 1].append(index)
            currentWidth += size.width + spacing
        }
        return rows
    }
}

// MARK: - Preview

#Preview("Feature Detail — Session Orchestration") {
    FeatureDetailPanelView(feature: .sessionOrchestration)
        .frame(width: 350, height: 700)
}

#Preview("Feature Detail — Container Security") {
    FeatureDetailPanelView(feature: .containerSecurity)
        .frame(width: 350, height: 700)
}
