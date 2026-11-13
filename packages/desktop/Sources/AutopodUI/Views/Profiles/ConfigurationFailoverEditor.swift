import AutopodClient
import SwiftUI

struct ConfigurationFailoverEditor: View {
  @Binding var route: [String: ConfigurationJSON]
  let role: ConfigurationFailoverRole
  let accounts: [PublicProviderAccountResponse]
  let initialTarget: [String: ConfigurationJSON]

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack(alignment: .top, spacing: 6) {
        Text(role.topic.summary).font(.callout).foregroundStyle(.secondary)
          .fixedSize(horizontal: false, vertical: true)
        ConfigurationHelpButton(topic: role.topic, id: "failover-\(role.rawValue)-about")
      }
      HStack {
        Stepper(
          "Maximum switches: \(Int(route["maxHops"]?.number ?? 0))",
          value: Binding(
            get: { Int(route["maxHops"]?.number ?? 0) },
            set: { route["maxHops"] = .number(Double($0)) }), in: 0...16)
          .accessibilityIdentifier("failover-\(role.rawValue)-switches")
        ConfigurationHelpButton(topic: .topic("ai.failover.switches"), id: "failover-\(role.rawValue)-limit-help")
      }
      Text(ConfigurationFailoverState(route: route).message)
        .font(.caption).foregroundStyle(.secondary)
        .fixedSize(horizontal: false, vertical: true)
        .accessibilityIdentifier("failover-\(role.rawValue)-status")
      ConfigurationObjectListEditor(
        title: "Backup accounts & models",
        values: Binding(get: { route["failover"]?.array ?? [] }, set: { route["failover"] = .array($0) }),
        initial: { initialTarget }
      ) { fields in
        VStack(alignment: .leading, spacing: 8) {
          ConfigurationAgentTargetEditor(fields: fields, accounts: accounts, showFailoverHelp: true)
          if let selected = fields.wrappedValue["providerAccountId"]?.string,
             let account = accounts.first(where: { $0.id == selected }), !account.hasCredentials {
            Label("This backup account needs credentials before it can be used.", systemImage: "key")
              .font(.caption).foregroundStyle(.secondary)
              .fixedSize(horizontal: false, vertical: true)
          }
        }
      }
    }.padding(6)
  }
}

struct ConfigurationFollowedFailover: View {
  let role: ConfigurationFailoverRole
  let source: String
  var body: some View {
    HStack(alignment: .firstTextBaseline, spacing: 6) {
      Text("\(role == .reviewer ? "Reviewer" : "Advisor"): uses \(source)'s route and backups.")
        .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
      ConfigurationHelpButton(topic: role.topic, id: "failover-\(role.rawValue)-about")
    }
  }
}
