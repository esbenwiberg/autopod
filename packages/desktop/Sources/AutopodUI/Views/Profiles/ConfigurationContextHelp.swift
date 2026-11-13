import SwiftUI

extension EnvironmentValues {
  @Entry var configurationHelpSection: String? = nil
}

/// Static presentation only. No bindings, discovery requests or save callbacks.
public struct ConfigurationContextHelp: View {
  private let topicID: String
  @State private var showing = false
  public init(topicID: String) { self.topicID = topicID }
  public var body: some View {
    let topic = ConfigurationHelpTopic.topic(topicID)
    VStack(alignment: .leading, spacing: 6) {
      HStack(alignment: .top, spacing: 10) {
        Text(topic.summary).font(.callout).foregroundStyle(.secondary)
          .fixedSize(horizontal: false, vertical: true)
        Spacer(minLength: 0)
        Button { showing = true } label: {
          Label("Settings explained", systemImage: "info.circle").fixedSize()
        }.buttonStyle(.plain).font(.caption).foregroundStyle(DesktopTheme.accent)
          .accessibilityIdentifier("configuration-section-help-\(topicID)")
      }
      Text(topic.impact).font(.caption).foregroundStyle(.secondary)
        .fixedSize(horizontal: false, vertical: true)
    }.frame(maxWidth: .infinity, alignment: .leading)
      .popover(isPresented: $showing, arrowEdge: .trailing) {
        ConfigurationSettingsBrowser(sectionID: topicID, close: { showing = false })
      }
  }
}

struct ConfigurationSettingsBrowser: View {
  let sectionID: String
  let close: () -> Void
  @State private var search = ""
  @State private var selected: ConfigurationHelpTopic?
  private var results: [ConfigurationHelpTopic] {
    let query = search.trimmingCharacters(in: .whitespacesAndNewlines)
    return ConfigurationHelpTopic.settings(in: sectionID).filter {
      query.isEmpty || ([$0.title, $0.summary] + $0.paths + Array($0.options?.keys ?? Dictionary<String, String>().keys))
        .joined(separator: " ").localizedCaseInsensitiveContains(query)
    }
  }
  var body: some View {
    if let selected {
      VStack(alignment: .leading, spacing: 0) {
        Button("← Settings") { self.selected = nil }
          .buttonStyle(.plain).padding([.top, .horizontal], 18)
          .accessibilityIdentifier("configuration-settings-back")
        ConfigurationHelpDetails(topic: selected, close: close)
      }
    } else {
      VStack(alignment: .leading, spacing: 12) {
        HStack {
          Text(ConfigurationHelpTopic.topic(sectionID).title).font(.headline)
            .accessibilityIdentifier("configuration-settings-browser")
          Spacer()
          Button("Done", action: close).keyboardShortcut(.cancelAction)
            .accessibilityIdentifier("configuration-settings-close")
        }
        TextField("Find a setting or JSON path", text: $search)
          .textFieldStyle(.roundedBorder).accessibilityIdentifier("configuration-settings-search")
        ScrollView {
          VStack(alignment: .leading, spacing: 12) {
            if results.isEmpty { Text("No matching settings. Try a field name or clear the search.").foregroundStyle(.secondary) }
            ForEach(results) { topic in
              Button { selected = topic } label: {
                VStack(alignment: .leading, spacing: 3) {
                  Text(topic.title).font(.callout.weight(.medium))
                  Text(topic.paths.joined(separator: ", ")).font(.caption).foregroundStyle(.secondary)
                    .lineLimit(2).multilineTextAlignment(.leading)
                }.frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
              }.buttonStyle(.plain).foregroundStyle(DesktopTheme.accent)
                .accessibilityIdentifier("configuration-topic-\(topic.id)")
            }
          }.frame(maxWidth: .infinity, alignment: .leading)
        }.frame(maxHeight: 340)
      }.padding(18).frame(width: 370).fixedSize(horizontal: false, vertical: true)
    }
  }
}

struct ConfigurationFieldLabel: View {
  @Environment(\.configurationHelpSection) private var section
  let title: String
  let key: String
  var path: String? = nil
  var body: some View {
    ConfigurationHelpLabel(title: title, topic: ConfigurationHelpTopic.field(key, section: section, path: path))
  }
}
