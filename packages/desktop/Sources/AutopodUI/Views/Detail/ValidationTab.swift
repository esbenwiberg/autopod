import SwiftUI

/// Validation results breakdown — smoke, tests, AC, task review.
public struct ValidationTab: View {
  public let session: Session
  public let checks: ValidationChecks?

  public init(session: Session, checks: ValidationChecks? = nil) {
    self.session = session
    self.checks = checks ?? session.validationChecks
  }

  public var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 16) {
        if let checks {
          // Summary
          HStack(spacing: 20) {
            validationBadge("Smoke", passed: checks.smoke, icon: "flame")
            validationBadge("Tests", passed: checks.tests, icon: "testtube.2")
            validationBadge("Review", passed: checks.review, icon: "eye")
          }
          .padding(16)
          .frame(maxWidth: .infinity)
          .background(Color(nsColor: .controlBackgroundColor))
          .clipShape(RoundedRectangle(cornerRadius: 10))

          // Attempt info
          if let attempts = session.attempts {
            HStack {
              Text("Attempt \(attempts.current) of \(attempts.max)")
                .font(.caption)
                .foregroundStyle(.secondary)
              Spacer()
            }
          }

          // Open Live App
          if let url = session.containerUrl, session.status == .validated || session.status == .validating {
            Button {
              NSWorkspace.shared.open(url)
            } label: {
              Label("Open Live App", systemImage: "safari")
                .frame(maxWidth: .infinity)
            }
            .buttonStyle(.bordered)
            .controlSize(.regular)
          }

          // Placeholder for detailed results (requires validation history from REST)
          detailSection("Smoke Tests", icon: "flame") {
            Text(checks.smoke ? "All smoke checks passed" : "Smoke checks failed")
              .font(.callout)
              .foregroundStyle(checks.smoke ? .green : .red)
            Text("Detailed results available in validation report")
              .font(.caption)
              .foregroundStyle(.tertiary)
          }

          detailSection("Test Suite", icon: "testtube.2") {
            Text(checks.tests ? "All tests passed" : "Tests failed or skipped")
              .font(.callout)
              .foregroundStyle(checks.tests ? .green : .secondary)
          }

          detailSection("Code Review", icon: "eye") {
            Text(checks.review ? "AI review passed" : "Review flagged issues")
              .font(.callout)
              .foregroundStyle(checks.review ? .green : .red)
          }

        } else {
          // No validation yet
          VStack(spacing: 10) {
            Image(systemName: "checkmark.seal")
              .font(.system(size: 32))
              .foregroundStyle(.tertiary)
            Text("No validation results yet")
              .font(.subheadline)
              .foregroundStyle(.secondary)
            if session.status == .validating {
              ProgressView("Validating…")
                .font(.caption)
            }
          }
          .frame(maxWidth: .infinity, maxHeight: .infinity)
          .padding(.top, 60)
        }
      }
      .padding(20)
    }
  }

  private func validationBadge(_ label: String, passed: Bool, icon: String) -> some View {
    VStack(spacing: 8) {
      ZStack {
        Circle()
          .fill(passed ? Color.green.opacity(0.1) : Color.red.opacity(0.1))
          .frame(width: 44, height: 44)
        Image(systemName: passed ? "checkmark" : "xmark")
          .font(.system(size: 16, weight: .bold))
          .foregroundStyle(passed ? .green : .red)
      }
      Text(label)
        .font(.caption)
        .foregroundStyle(.secondary)
    }
  }

  private func detailSection<Content: View>(
    _ title: String, icon: String,
    @ViewBuilder content: @escaping () -> Content
  ) -> some View {
    DisclosureGroup {
      VStack(alignment: .leading, spacing: 8) {
        content()
      }
      .padding(.top, 6)
    } label: {
      HStack(spacing: 6) {
        Image(systemName: icon)
          .font(.system(size: 11))
          .foregroundStyle(.blue)
        Text(title)
          .font(.system(.subheadline).weight(.semibold))
      }
    }
    .padding(12)
    .background(Color(nsColor: .controlBackgroundColor))
    .clipShape(RoundedRectangle(cornerRadius: 8))
  }
}

#Preview("Validation — passed") {
  ValidationTab(
    session: MockData.validated,
    checks: ValidationChecks(smoke: true, tests: true, review: true)
  )
  .frame(width: 500, height: 500)
}

#Preview("Validation — failed") {
  ValidationTab(
    session: MockData.failed,
    checks: ValidationChecks(smoke: true, tests: false, review: false)
  )
  .frame(width: 500, height: 500)
}
