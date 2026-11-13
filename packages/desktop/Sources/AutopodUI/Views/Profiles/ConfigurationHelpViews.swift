import SwiftUI

/// Click/focus-accessible detail, not hover-only help. State is local to the view.
struct ConfigurationHelpButton: View {
  let topic: ConfigurationHelpTopic
  var id: String? = nil
  @State private var showing = false
  var body: some View {
    Button { showing.toggle() } label: {
      Image(systemName: "info.circle").font(.callout)
        .frame(minWidth: 24, minHeight: 24)
        .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .foregroundStyle(.secondary)
    .accessibilityLabel("About \(topic.title)")
    .accessibilityHint("Opens an explanation. Does not change configuration.")
    .accessibilityIdentifier(id ?? "configuration-help-\(topic.id)")
    .help("About \(topic.title)")
    .popover(isPresented: $showing, arrowEdge: .trailing) {
      ConfigurationHelpDetails(topic: topic, close: { showing = false })
    }
  }
}

struct ConfigurationHelpDetails: View {
  let topic: ConfigurationHelpTopic
  let close: () -> Void
  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack(alignment: .firstTextBaseline) {
        Text(topic.title).font(.headline).accessibilityIdentifier("configuration-help-details")
        Spacer()
        Button("Done", action: close).keyboardShortcut(.cancelAction)
          .accessibilityIdentifier("configuration-help-close")
      }
      ScrollView {
        VStack(alignment: .leading, spacing: 14) {
          if let source = topic.source { detail("Configured in", source) }
          detail("When to use it", topic.whenToUse)
          detail("What happens", topic.behavior)
          detail("Default / off", topic.defaultBehavior)
          detail("Impact", topic.impact)
          if let options = topic.options, !options.isEmpty {
            DisclosureGroup("Choices") {
              VStack(alignment: .leading, spacing: 8) {
                ForEach(options.keys.sorted(), id: \.self) { key in
                  Text("\(key): \(options[key] ?? "")").frame(maxWidth: .infinity, alignment: .leading)
                }
              }.padding(.top, 6)
            }.accessibilityIdentifier("configuration-help-choices")
          }
          if !topic.example.isEmpty {
            DisclosureGroup("Example") {
              Text(topic.example).frame(maxWidth: .infinity, alignment: .leading).padding(.top, 6)
            }.accessibilityIdentifier("configuration-help-example")
          }
          if !topic.paths.isEmpty {
            DisclosureGroup("JSON paths") {
              Text(topic.paths.joined(separator: "\n")).font(.system(.caption, design: .monospaced))
                .frame(maxWidth: .infinity, alignment: .leading).padding(.top, 6)
            }.accessibilityIdentifier("configuration-help-paths")
          }
        }.font(.callout).textSelection(.enabled)
          .frame(maxWidth: .infinity, alignment: .leading).padding(.trailing, 6)
      }.frame(maxHeight: 400)
    }.padding(18).frame(width: 370)
      .fixedSize(horizontal: false, vertical: true)
  }
  private func detail(_ heading: String, _ text: String) -> some View {
    VStack(alignment: .leading, spacing: 4) {
      Text(heading).font(.subheadline.weight(.semibold))
      Text(text).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
    }
  }
}

struct ConfigurationHelpLabel: View {
  @Environment(\.configurationHelpSection) private var section
  let title: String
  let topic: ConfigurationHelpTopic?
  var body: some View {
    HStack(spacing: 4) {
      Text(title)
      if let explanation = topic ?? ConfigurationHelpTopic.named(title, section: section) {
        ConfigurationHelpButton(topic: explanation)
      }
    }
  }
}

struct ConfigurationHelpSummary: View {
  let topic: ConfigurationHelpTopic
  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      HStack(alignment: .top, spacing: 6) {
        Text(topic.summary).foregroundStyle(.secondary)
          .fixedSize(horizontal: false, vertical: true)
        ConfigurationHelpButton(topic: topic)
      }.font(.callout)
      Text(topic.impact).font(.caption).foregroundStyle(.secondary)
        .fixedSize(horizontal: false, vertical: true)
    }
  }
}
