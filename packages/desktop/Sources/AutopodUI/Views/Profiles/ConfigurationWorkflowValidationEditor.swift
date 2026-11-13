import AutopodClient
import SwiftUI

enum ConfigurationValidationPhase: String, CaseIterable, Identifiable {
  case setup, lint, sast, build, test, health, pages, facts, review, advisory
  var id: String { rawValue }
  var topic: ConfigurationHelpTopic { .topic("workflow.validation.\(rawValue)") }
  var toggleID: String { self == .advisory ? "workflow-advisory-browser-qa" : "workflow-validation-\(rawValue)" }
  var sourceLabel: String {
    switch self {
    case .setup: "Repository · Setup command"
    case .lint: "Repository · Lint command"
    case .sast: "Repository · SAST command"
    case .build: "Repository · Build command"
    case .test: "Repository · Test command"
    case .health: "Repository · Start & health settings"
    case .pages: "Repository · Smoke pages"
    case .facts: "Task · Structured acceptance spec"
    case .review: "AI setup · Reviewer"
    case .advisory: "Web targets · Task checklist · Reviewer"
    }
  }
  var sourceKinds: [ConfigurationKind] {
    switch self {
    case .facts: []
    case .review: [.ai]
    case .advisory: [.repository, .ai]
    default: [.repository]
    }
  }
  func isEnabled(_ payload: [String: ConfigurationJSON]) -> Bool {
    self == .advisory ? ConfigurationAdvisoryBrowserQA.isEnabled(payload)
      : payload["validationPhases"]?.array?.contains(.string(rawValue)) ?? false
  }
  func setEnabled(_ enabled: Bool, in payload: inout [String: ConfigurationJSON]) {
    if self == .advisory {
      ConfigurationAdvisoryBrowserQA.setEnabled(enabled, in: &payload)
    } else {
      var values = payload["validationPhases"]?.array ?? []
      values.removeAll { $0 == .string(rawValue) }
      if enabled { values.append(.string(rawValue)) }
      payload["validationPhases"] = .array(values)
    }
  }
}

struct ConfigurationWorkflowValidationEditor: View {
  @Binding var payload: [String: ConfigurationJSON]
  let documents: [ConfigurationDocument]
  var openSource: ((ConfigurationDocument) -> Void)? = nil

  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      ConfigurationHelpSummary(topic: .topic("workflow.validation"))
      ConfigurationSection(title: "Validation checks") {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 250), alignment: .topLeading)], alignment: .leading, spacing: 18) {
          ForEach(ConfigurationValidationPhase.allCases) { phase in
            VStack(alignment: .leading, spacing: 4) {
              HStack(alignment: .firstTextBaseline, spacing: 4) {
                Toggle(phase.topic.title, isOn: Binding(get: { phase.isEnabled(payload) }, set: {
                  phase.setEnabled($0, in: &payload)
                })).accessibilityIdentifier(phase.toggleID)
                ConfigurationHelpButton(topic: phase.topic)
              }
              Text(phase.topic.summary).font(.caption).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
              if phase.sourceKinds.isEmpty {
                Text(phase.sourceLabel).font(.caption).foregroundStyle(.secondary)
                  .fixedSize(horizontal: false, vertical: true)
              } else {
                ConfigurationValidationSourceButton(phase: phase, documents: documents, openSource: openSource)
              }
            }.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
          }
        }
      }
      HStack(alignment: .firstTextBaseline, spacing: 6) {
        Stepper("Validation attempts: \(Int(payload["maxValidationAttempts"]?.number ?? 3))",
          value: Binding(get: { Int(payload["maxValidationAttempts"]?.number ?? 3) },
            set: { payload["maxValidationAttempts"] = .number(Double($0)) }), in: 1...10)
          .accessibilityIdentifier("workflow-validation-attempts")
        ConfigurationHelpButton(topic: .topic("workflow.validation.attempts"))
      }
      Text("Includes the first validation run; not a per-command retry count.")
        .font(.caption).foregroundStyle(.secondary)
        .fixedSize(horizontal: false, vertical: true)
    }
  }
}

/// A reusable Workflow has no unique launch context. Browse saved owners explicitly;
/// never guess a Repository command, AI selection or launch default.
struct ConfigurationValidationSourceButton: View {
  let phase: ConfigurationValidationPhase
  let documents: [ConfigurationDocument]
  var openSource: ((ConfigurationDocument) -> Void)?
  @State private var showing = false

  var body: some View {
    Button { showing = true } label: {
      Label(phase.sourceLabel, systemImage: "arrow.up.right")
        .fixedSize(horizontal: false, vertical: true).multilineTextAlignment(.leading)
    }.buttonStyle(.plain).font(.caption).foregroundStyle(DesktopTheme.accent)
      .accessibilityIdentifier("workflow-validation-source-\(phase.id)")
      .accessibilityHint("Choose a saved building block to inspect. Does not select a launch default.")
      .popover(isPresented: $showing, arrowEdge: .trailing) {
        VStack(alignment: .leading, spacing: 12) {
          HStack {
            Text("Inspect validation sources").font(.headline)
              .accessibilityIdentifier("validation-source-chooser")
            Spacer()
            Button("Done") { showing = false }.keyboardShortcut(.cancelAction)
              .accessibilityIdentifier("validation-source-close")
          }
          Text("Choose a saved building block to inspect. The launch selects the actual Repository setup and AI setup.")
            .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
          ScrollView {
            VStack(alignment: .leading, spacing: 10) {
              ForEach(phase.sourceKinds) { kind in
                let available = documents.filter { $0.kind == kind && !$0.archived }
                  .sorted { $0.libraryTitle.localizedStandardCompare($1.libraryTitle) == .orderedAscending }
                Text(kind == .repository ? "Repository project setups" : "AI setup · Reviewer")
                  .font(.subheadline.weight(.semibold))
                if available.isEmpty {
                  Text(kind == .repository ? "No repositories available. Add a repository to configure its check commands." : "No AI setups available. Add an AI setup to configure Reviewer.")
                    .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                }
                ForEach(available) { document in
                  Button {
                    showing = false
                    openSource?(document)
                  } label: {
                    Label(document.libraryTitle, systemImage: "arrow.up.right")
                      .frame(maxWidth: .infinity, alignment: .leading)
                  }.buttonStyle(.plain).foregroundStyle(DesktopTheme.accent)
                    .disabled(openSource == nil)
                    .accessibilityIdentifier("validation-source-open-\(document.id)")
                }
              }
            }.frame(maxWidth: .infinity, alignment: .leading)
          }.frame(maxHeight: 260)
          if openSource == nil {
            Text("Editor navigation is unavailable in this view.").font(.caption).foregroundStyle(.secondary)
          }
        }.padding(18).frame(width: 370).fixedSize(horizontal: false, vertical: true)
      }
  }
}
