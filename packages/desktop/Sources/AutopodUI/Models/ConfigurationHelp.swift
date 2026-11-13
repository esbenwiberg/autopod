import AutopodClient
import Foundation

/// Bundled, generated from shared/src/configuration-help/*.json.
/// Help is presentation-only; it never enters configuration payloads or launch digests.
struct ConfigurationHelpTopic: Decodable, Identifiable, Sendable {
  let id: String
  let title: String
  let summary: String
  let whenToUse: String
  let behavior: String
  let defaultBehavior: String
  let impact: String
  let example: String
  let paths: [String]
  let areas: [String]?
  let options: [String: String]?
  let source: String?
  let sourceKind: String?

  private struct Catalog: Decodable { let version: Int; let topics: [ConfigurationHelpTopic] }
  static let all: [ConfigurationHelpTopic] = {
    ["failover", "validation", "instructions", "settings"].flatMap { name -> [ConfigurationHelpTopic] in
      guard let url = Bundle.module.url(forResource: name, withExtension: "json", subdirectory: "ConfigurationHelp"),
            let data = try? Data(contentsOf: url),
            let catalog = try? JSONDecoder().decode(Catalog.self, from: data), catalog.version == 1 else {
        preconditionFailure("Missing or invalid bundled configuration help: \(name)")
      }
      return catalog.topics
    }
  }()

  static func settings(in section: String) -> [ConfigurationHelpTopic] {
    let kind = section.components(separatedBy: ".").first ?? ""
    return all.filter { topic in
      guard topic.id.hasPrefix(kind + "."), !topic.paths.isEmpty else { return false }
      if section.hasSuffix(".advanced") || section.hasSuffix(".overview") { return true }
      if section == "ai.sections.failover", topic.id.hasPrefix("ai.failover") { return true }
      if section == "workflow.sections.validation", topic.id.hasPrefix("workflow.validation") { return true }
      if section == "toolPack.sections.instructions", topic.id.hasPrefix("toolPack.instructions") { return true }
      if topic.areas?.contains(section) == true { return true }
      if section == "repository.sections.setups" {
        return topic.areas?.contains { ["commands", "validation", "pages", "variables", "registries", "services", "deployment"].contains($0.components(separatedBy: ".").last ?? "") } == true
      }
      return false
    }.sorted { $0.title.localizedStandardCompare($1.title) == .orderedAscending }
  }

  static func field(_ key: String, section: String?, path: String? = nil) -> ConfigurationHelpTopic? {
    guard let section else { return nil }
    let matches = settings(in: section).filter { topic in topic.paths.contains { candidate in
      if let path { return candidate == path }
      return candidate.components(separatedBy: ".").last?.replacingOccurrences(of: "[]", with: "") == key
    } }
    // Never guess between unrelated nested objects sharing a leaf name.
    return matches.count == 1 ? matches.first : nil
  }

  static func named(_ title: String, section: String?) -> ConfigurationHelpTopic? {
    guard let section else { return nil }
    let matches = settings(in: section).filter { $0.title.caseInsensitiveCompare(title) == .orderedSame }
    return matches.count == 1 ? matches.first : nil
  }

  static func topic(_ id: String) -> ConfigurationHelpTopic {
    guard let topic = all.first(where: { $0.id == id }) else {
      preconditionFailure("Unknown configuration help topic: \(id)")
    }
    return topic
  }
}

enum ConfigurationFailoverRole: String, CaseIterable {
  case main, reviewer, advisor
  var topic: ConfigurationHelpTopic { .topic("ai.failover.\(rawValue)") }
}

enum ConfigurationFailoverState: Equatable {
  case disabled, noBackups, configured
  init(route: [String: ConfigurationJSON]) {
    if (route["maxHops"]?.number ?? 0) == 0 { self = .disabled }
    else if route["failover"]?.array?.isEmpty != false { self = .noBackups }
    else { self = .configured }
  }
  var message: String {
    switch self {
    case .disabled: "Off — no automatic switching. Saved backups stay inactive."
    case .noBackups: "Off — add a backup account and model to allow switching."
    case .configured: "Backups are tried in order, within the switch limit."
    }
  }
}
