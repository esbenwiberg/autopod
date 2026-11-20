import AppKit
import AutopodClient
import SwiftUI

struct ParentFamilyCard: View {
  @Environment(\.desktopRedesign) private var redesign

  let family: ParentManagedFamily
  let isStale: Bool
  let isRefreshing: Bool
  let refresh: () -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack(alignment: .top, spacing: 8) {
        Image(systemName: "point.3.connected.trianglepath.dotted")
          .font(.system(size: 14, weight: .semibold))
          .foregroundStyle(.secondary)
          .frame(width: 20)
        VStack(alignment: .leading, spacing: 2) {
          Text("Parent-managed family")
            .font(.subheadline.weight(.semibold))
          Text("Run \(family.run) · \(family.children.count) child\(family.children.count == 1 ? "" : "ren")")
            .font(.caption)
            .foregroundStyle(.secondary)
            .textSelection(.enabled)
        }
        Spacer(minLength: 8)
        if isRefreshing {
          ProgressView().controlSize(.small)
        }
        Button(action: refresh) {
          Image(systemName: "arrow.clockwise")
        }
        .buttonStyle(.plain)
        .disabled(isRefreshing)
        .help("Refresh this parent family")
        .accessibilityIdentifier("parent-family-refresh")
      }

      if isStale {
        Label("Showing the last known family. Refresh failed, so child states may be stale.", systemImage: "exclamationmark.triangle.fill")
          .font(.caption)
          .foregroundStyle(.orange)
          .fixedSize(horizontal: false, vertical: true)
          .accessibilityIdentifier("parent-family-stale")
      }

      if family.children.isEmpty {
        Text("No child requests were recorded for this run.")
          .font(.caption)
          .foregroundStyle(.secondary)
      } else {
        VStack(spacing: 8) {
          ForEach(Array(family.children.enumerated()), id: \.offset) { _, child in
            childRow(child)
          }
        }
      }
    }
    .padding(14)
    .background(redesign ? DesktopTheme.canvas : Color(nsColor: .controlBackgroundColor))
    .clipShape(RoundedRectangle(cornerRadius: 10))
    .overlay(RoundedRectangle(cornerRadius: 10).stroke(Color.secondary.opacity(0.14), lineWidth: 1))
    .accessibilityIdentifier("parent-family-card")
  }

  private func childRow(_ child: ParentManagedChild) -> some View {
    let presentation = ParentManagedChildPresentation(child)
    let color = color(for: presentation.tone)

    return HStack(alignment: .top, spacing: 9) {
      Image(systemName: presentation.symbol)
        .font(.system(size: 13, weight: .semibold))
        .foregroundStyle(color)
        .frame(width: 18)
      VStack(alignment: .leading, spacing: 3) {
        HStack(spacing: 6) {
          Text(presentation.title)
            .font(.caption.weight(.semibold))
          Text(child.requestKey)
            .font(.system(.caption2, design: .monospaced))
            .foregroundStyle(.secondary)
            .lineLimit(1)
            .truncationMode(.middle)
        }
        Text(presentation.detail)
          .font(.caption2)
          .foregroundStyle(.secondary)
        Text("Parent attempt \(child.parentAttempt)")
          .font(.system(.caption2, design: .monospaced))
          .foregroundStyle(.tertiary)
        if let childID = child.child, !childID.isEmpty {
          HStack(spacing: 5) {
            Text(childID)
              .font(.system(.caption, design: .monospaced))
              .lineLimit(1)
              .truncationMode(.middle)
              .textSelection(.enabled)
            Button {
              NSPasteboard.general.clearContents()
              NSPasteboard.general.setString(childID, forType: .string)
            } label: {
              Image(systemName: "doc.on.doc")
                .font(.system(size: 10))
            }
            .buttonStyle(.plain)
            .help("Copy child task ID")
            .accessibilityLabel("Copy child task ID \(childID)")
          }
        }
      }
      Spacer(minLength: 0)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .padding(9)
    .background(color.opacity(0.06), in: RoundedRectangle(cornerRadius: 8))
  }

  private func color(for tone: ParentManagedChildTone) -> Color {
    switch tone {
    case .reserved: .secondary
    case .started: .blue
    case .exited: .secondary
    case .unknown: .orange
    }
  }
}
