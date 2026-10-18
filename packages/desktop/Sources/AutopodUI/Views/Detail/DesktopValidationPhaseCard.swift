import AutopodClient
import SwiftUI

struct DesktopValidationPhaseCard: View {
  let phase: ValidationPhase
  let state: ValidationPhaseState
  let isSelected: Bool
  let subLabel: String?
  let action: () -> Void

  private var icon: String {
    switch phase {
    case .setup: "shippingbox"
    case .lint: "text.badge.checkmark"
    case .sast: "shield.lefthalf.filled"
    case .build: "hammer"
    case .test: "testtube.2"
    case .health: "heart.text.square"
    case .pages: "globe"
    case .facts: "checkmark.seal"
    case .review: "checkmark.bubble"
    case .advisory: "sparkles"
    }
  }
  private var status: String {
    switch state.status {
    case .notStarted: "Not started"
    case .running: "Running"
    case .passed: "Passed"
    case .failed: "Failed"
    case .skipped: "Skipped"
    case .pendingHuman: "Needs review"
    }
  }
  var body: some View {
    Button(action: action) {
      VStack(alignment: .leading, spacing: 10) {
        HStack {
          Image(systemName: icon).font(.system(size: 17, weight: .medium))
            .foregroundStyle(isSelected ? DesktopTheme.accent : .secondary)
          Spacer(minLength: 8)
          if state.status == .running {
            ProgressView().controlSize(.mini)
          } else {
            Image(systemName: state.status.icon).font(.caption2).foregroundStyle(state.status.color)
          }
        }
        Text(phase.displayName).font(.callout.weight(.semibold))
        Text(subLabel ?? status).font(.caption2).foregroundStyle(state.status.color)
          .lineLimit(1).truncationMode(.middle)
      }
      .padding(12).frame(width: 108, height: 94, alignment: .topLeading)
      .background(isSelected ? DesktopTheme.selection : DesktopTheme.canvas, in: RoundedRectangle(cornerRadius: 8))
      .overlay(RoundedRectangle(cornerRadius: 8).stroke(isSelected ? DesktopTheme.accent : DesktopTheme.line))
      .contentShape(RoundedRectangle(cornerRadius: 8))
    }
    .buttonStyle(.plain)
    .help([phase.displayName, status, subLabel].compactMap { $0 }.joined(separator: " · "))
    .accessibilityLabel("\(phase.displayName), \(status)")
    .accessibilityIdentifier("validation-phase-\(phase.rawValue)")
    .accessibilityAddTraits(isSelected ? .isSelected : [])
  }
}
