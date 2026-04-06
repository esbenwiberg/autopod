import SwiftUI

/// Validation results breakdown — smoke, tests, AC, task review.
public struct ValidationTab: View {
  public let session: Session
  public let checks: ValidationChecks?
  @State private var expandedBuildOutput = false
  @State private var expandedTestOutput = false

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
            validationBadge("Smoke", status: checks.smoke, icon: "flame")
            validationBadge("Tests", status: checks.tests, icon: "testtube.2")
            if let acPassed = checks.acValidation {
              validationBadge("AC", status: acPassed, icon: "checklist.checked")
            }
            validationBadge("Review", status: checks.review, icon: "eye")
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

          // Acceptance criteria (full list)
          if let criteria = session.acceptanceCriteria, !criteria.isEmpty {
            detailSection("Acceptance Criteria (\(criteria.count))", icon: "checklist") {
              VStack(alignment: .leading, spacing: 6) {
                if let source = session.acFrom {
                  HStack(spacing: 3) {
                    Image(systemName: "doc.text")
                      .font(.system(size: 9))
                    Text(source)
                      .font(.system(.caption2, design: .monospaced))
                  }
                  .foregroundStyle(.tertiary)
                }
                ForEach(Array(criteria.enumerated()), id: \.offset) { _, criterion in
                  HStack(alignment: .top, spacing: 8) {
                    Image(systemName: "square")
                      .font(.system(size: 12))
                      .foregroundStyle(.secondary)
                      .padding(.top, 1)
                    Text(criterion)
                      .font(.callout)
                  }
                }
              }
            }
          }

          // Build / Smoke
          detailSection("Build & Smoke Tests", icon: "flame", expanded: !checks.smoke) {
            Text(checks.smoke ? "All smoke checks passed" : "Smoke checks failed")
              .font(.callout)
              .foregroundStyle(checks.smoke ? .green : .red)
            if let output = checks.buildOutput {
              Text("Build Output")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
                .padding(.top, 4)
              ScrollView(.horizontal, showsIndicators: true) {
                Text(expandedBuildOutput ? output : tailLines(output))
                  .font(.system(.caption2, design: .monospaced))
                  .foregroundStyle(.red.opacity(0.9))
                  .textSelection(.enabled)
              }
              .frame(maxHeight: expandedBuildOutput ? .infinity : 300)
              .padding(8)
              .background(Color.black.opacity(0.3))
              .clipShape(RoundedRectangle(cornerRadius: 6))
              outputToggle(expanded: $expandedBuildOutput, lineCount: output.split(separator: "\n").count)
            }
            if let health = checks.healthCheck, health.status == "fail" {
              VStack(alignment: .leading, spacing: 4) {
                Text("Health Check")
                  .font(.caption.weight(.semibold))
                  .foregroundStyle(.secondary)
                HStack(spacing: 12) {
                  Label(health.url, systemImage: "link")
                    .font(.system(.caption2, design: .monospaced))
                  if let code = health.responseCode {
                    Text("HTTP \(code)")
                      .font(.caption2.weight(.medium))
                      .foregroundStyle(.red)
                  } else {
                    Text("No response")
                      .font(.caption2)
                      .foregroundStyle(.red)
                  }
                }
              }
              .padding(.top, 4)
            }
            if let pages = checks.pages?.filter({ $0.status == "fail" }), !pages.isEmpty {
              VStack(alignment: .leading, spacing: 8) {
                Text("Failed Pages")
                  .font(.caption.weight(.semibold))
                  .foregroundStyle(.secondary)
                ForEach(Array(pages.enumerated()), id: \.offset) { _, page in
                  VStack(alignment: .leading, spacing: 4) {
                    HStack {
                      Text(page.path)
                        .font(.system(.caption, design: .monospaced).weight(.medium))
                      Spacer()
                      Text("\(page.loadTime)ms")
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                    }
                    ForEach(Array(page.assertions.filter { !$0.passed }.enumerated()), id: \.offset) { _, a in
                      HStack(alignment: .top, spacing: 6) {
                        Image(systemName: "xmark.circle.fill")
                          .font(.system(size: 9))
                          .foregroundStyle(.red)
                          .padding(.top, 2)
                        VStack(alignment: .leading, spacing: 1) {
                          Text("\(a.type): \(a.selector)")
                            .font(.system(.caption2, design: .monospaced))
                          if let expected = a.expected, let actual = a.actual {
                            Text("expected \(expected), got \(actual)")
                              .font(.caption2)
                              .foregroundStyle(.secondary)
                          }
                        }
                      }
                    }
                    if !page.consoleErrors.isEmpty {
                      VStack(alignment: .leading, spacing: 2) {
                        Text("Console Errors")
                          .font(.caption2.weight(.semibold))
                          .foregroundStyle(.orange)
                        ForEach(Array(page.consoleErrors.enumerated()), id: \.offset) { _, err in
                          Text(err)
                            .font(.system(.caption2, design: .monospaced))
                            .foregroundStyle(.orange.opacity(0.9))
                            .lineLimit(3)
                        }
                      }
                    }
                  }
                  .padding(8)
                  .background(Color.red.opacity(0.05))
                  .clipShape(RoundedRectangle(cornerRadius: 6))
                }
              }
              .padding(.top, 4)
            }
          }

          // Test Suite
          detailSection("Test Suite", icon: "testtube.2", expanded: checks.tests == false) {
            switch checks.tests {
            case true:
              Text("All tests passed")
                .font(.callout)
                .foregroundStyle(.green)
            case false:
              Text("Tests failed")
                .font(.callout)
                .foregroundStyle(.red)
            case nil:
              Text("Tests skipped")
                .font(.callout)
                .foregroundStyle(.secondary)
              Text(!checks.smoke
                   ? "Build failed \u{2014} tests were not executed"
                   : "No test command configured")
                .font(.caption)
                .foregroundStyle(.secondary)
            }
            if let output = checks.testOutput {
              Text("Test Output")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
                .padding(.top, 4)
              ScrollView(.horizontal, showsIndicators: true) {
                Text(expandedTestOutput ? output : tailLines(output))
                  .font(.system(.caption2, design: .monospaced))
                  .foregroundStyle(.red.opacity(0.9))
                  .textSelection(.enabled)
              }
              .frame(maxHeight: expandedTestOutput ? .infinity : 300)
              .padding(8)
              .background(Color.black.opacity(0.3))
              .clipShape(RoundedRectangle(cornerRadius: 6))
              outputToggle(expanded: $expandedTestOutput, lineCount: output.split(separator: "\n").count)
            }
          }

          // AC Validation
          if let acChecks = checks.acChecks, checks.acValidation != nil {
            detailSection("AC Validation", icon: "checklist.checked",
                          expanded: checks.acValidation == false) {
              Text(checks.acValidation == true
                   ? "All acceptance criteria verified"
                   : "Some criteria not met")
                .font(.callout)
                .foregroundStyle(checks.acValidation == true ? .green : .red)
              VStack(alignment: .leading, spacing: 6) {
                ForEach(Array(acChecks.enumerated()), id: \.offset) { _, check in
                  HStack(alignment: .top, spacing: 6) {
                    Image(systemName: check.passed
                          ? "checkmark.circle.fill" : "xmark.circle.fill")
                      .font(.system(size: 11))
                      .foregroundStyle(check.passed ? .green : .red)
                      .padding(.top, 1)
                    VStack(alignment: .leading, spacing: 2) {
                      Text(check.criterion)
                        .font(.callout)
                      Text(check.reasoning)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    }
                  }
                }
              }
              .padding(.top, 4)
            }
          }

          // Code Review
          detailSection("Code Review", icon: "eye", expanded: checks.review == false) {
            switch checks.review {
            case true:
              Text("AI review passed")
                .font(.callout)
                .foregroundStyle(.green)
            case false:
              Text("Review flagged issues")
                .font(.callout)
                .foregroundStyle(.red)
            case nil:
              Text("Review skipped")
                .font(.callout)
                .foregroundStyle(.secondary)
              Text("No reviewer model configured")
                .font(.caption)
                .foregroundStyle(.secondary)
            }
            if let reasoning = checks.reviewReasoning {
              Text(reasoning)
                .font(.caption)
                .foregroundStyle(.secondary)
                .padding(.top, 4)
            }
            if let issues = checks.reviewIssues, !issues.isEmpty {
              VStack(alignment: .leading, spacing: 4) {
                ForEach(Array(issues.enumerated()), id: \.offset) { _, issue in
                  HStack(alignment: .top, spacing: 6) {
                    Image(systemName: "exclamationmark.triangle")
                      .font(.system(size: 9))
                      .foregroundStyle(.red)
                      .padding(.top, 2)
                    Text(issue)
                      .font(.caption)
                  }
                }
              }
              .padding(.top, 4)
            }
            if let reqs = checks.requirementsCheck, !reqs.isEmpty {
              VStack(alignment: .leading, spacing: 4) {
                Text("Requirements Coverage")
                  .font(.caption.weight(.semibold))
                  .foregroundStyle(.secondary)
                  .padding(.top, 4)
                ForEach(Array(reqs.enumerated()), id: \.offset) { _, req in
                  HStack(alignment: .top, spacing: 6) {
                    Image(systemName: req.met
                          ? "checkmark.circle.fill" : "xmark.circle.fill")
                      .font(.system(size: 9))
                      .foregroundStyle(req.met ? .green : .red)
                      .padding(.top, 2)
                    VStack(alignment: .leading, spacing: 1) {
                      Text(req.criterion)
                        .font(.caption)
                      if let note = req.note {
                        Text(note)
                          .font(.caption2)
                          .foregroundStyle(.secondary)
                      }
                    }
                  }
                }
              }
            }
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

  private func validationBadge(_ label: String, status: Bool?, icon: String) -> some View {
    let color: Color = switch status {
    case true: .green
    case false: .red
    case nil: .gray
    }
    let iconName: String = switch status {
    case true: "checkmark"
    case false: "xmark"
    case nil: "minus"
    }
    return VStack(spacing: 8) {
      ZStack {
        Circle()
          .fill(color.opacity(0.1))
          .frame(width: 44, height: 44)
        Image(systemName: iconName)
          .font(.system(size: 16, weight: .bold))
          .foregroundStyle(color)
      }
      Text(label)
        .font(.caption)
        .foregroundStyle(.secondary)
    }
  }

  private func tailLines(_ text: String, count: Int = 100) -> String {
    let lines = text.split(separator: "\n", omittingEmptySubsequences: false)
    if lines.count <= count { return text }
    return "\u{2026} (\(lines.count - count) lines truncated)\n" +
           lines.suffix(count).joined(separator: "\n")
  }

  private func outputToggle(expanded: Binding<Bool>, lineCount: Int) -> some View {
    Group {
      if lineCount > 100 {
        Button(expanded.wrappedValue ? "Show Less" : "Show All (\(lineCount) lines)") {
          expanded.wrappedValue.toggle()
        }
        .font(.caption)
        .foregroundStyle(.blue)
      }
    }
  }

  private func detailSection<Content: View>(
    _ title: String, icon: String, expanded: Bool = false,
    @ViewBuilder content: @escaping () -> Content
  ) -> some View {
    CollapsibleSection(title: title, icon: icon, content: content, initiallyExpanded: expanded)
  }
}

/// Expandable section with its own state — fixes DisclosureGroup not toggling.
private struct CollapsibleSection<Content: View>: View {
  let title: String
  let icon: String
  @ViewBuilder let content: () -> Content
  var initiallyExpanded: Bool = false
  @State private var isExpanded: Bool?

  private var expanded: Bool { isExpanded ?? initiallyExpanded }

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      Button {
        withAnimation(.easeOut(duration: 0.15)) { isExpanded = !expanded }
      } label: {
        HStack(spacing: 6) {
          Image(systemName: expanded ? "chevron.down" : "chevron.right")
            .font(.system(size: 9, weight: .semibold))
            .foregroundStyle(.tertiary)
            .frame(width: 12)
          Image(systemName: icon)
            .font(.system(size: 11))
            .foregroundStyle(.blue)
          Text(title)
            .font(.system(.subheadline).weight(.semibold))
          Spacer()
        }
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .padding(12)

      if expanded {
        Divider().padding(.horizontal, 12)
        VStack(alignment: .leading, spacing: 8) {
          content()
        }
        .padding(12)
      }
    }
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
    session: MockData.validatedFailed
  )
  .frame(width: 500, height: 700)
}

#Preview("Validation — skipped") {
  ValidationTab(
    session: MockData.validated,
    checks: ValidationChecks(
      smoke: false, tests: nil, review: nil,
      buildOutput: "error: Module 'foo' not found\nexit code 1"
    )
  )
  .frame(width: 500, height: 500)
}
