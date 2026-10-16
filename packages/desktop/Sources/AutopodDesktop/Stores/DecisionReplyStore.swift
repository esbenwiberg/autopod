import Foundation
import AutopodUI

/// Process-lifetime text, shared by every handler and reply surface on this PodStore.
@Observable
@MainActor
final class DecisionReplyStore {
  struct Key: Hashable {
    let source: PodStore.Source
    let podID: String
    let decisionID: String
  }

  @Observable
  final class Record {
    let id = UUID()
    var revision = UUID()
    var text = ""
    var notice: String?
    var acknowledged = false
    var attemptID: UUID?
    @ObservationIgnored var task: Task<DecisionReplyOutcome, Never>?

    func edit(_ text: String) {
      self.text = text
      revision = UUID()
    }
  }

  private struct PodKey: Hashable {
    let source: PodStore.Source
    let podID: String
  }
  private struct Active {
    let id: UUID
    let task: Task<DecisionReplyOutcome, Never>
  }
  private var records: [Key: Record] = [:]
  private var active: [Key: Active] = [:]
  private var lifetimes: [PodKey: UUID] = [:]

  func lifetime(source: PodStore.Source, podID: String) -> UUID {
    let key = PodKey(source: source, podID: podID)
    if let id = lifetimes[key] { return id }
    let id = UUID()
    lifetimes[key] = id
    return id
  }

  func ownsLifetime(source: PodStore.Source, podID: String, id: UUID) -> Bool {
    lifetimes[PodKey(source: source, podID: podID)] == id
  }

  func pending(_ key: Key) -> Task<DecisionReplyOutcome, Never>? { active[key]?.task }
  func admit(_ key: Key, id: UUID, task: Task<DecisionReplyOutcome, Never>) {
    active[key] = Active(id: id, task: task)
  }
  func settle(_ key: Key, id: UUID) {
    if active[key]?.id == id { active.removeValue(forKey: key) }
  }

  func read(_ key: Key) -> Record? { records[key] }

  func get(_ key: Key) -> Record {
    if let record = records[key] { return record }
    let record = Record()
    records[key] = record
    return record
  }

  func owns(_ key: Key, _ record: Record) -> Bool { records[key]?.id == record.id }

  func forget(source: PodStore.Source?, podID: String) {
    // A running task retains its detached record until it settles. Reinsertions get
    // a fresh record; their text/admission cannot be touched by that old completion.
    records = records.filter { $0.key.source != source || $0.key.podID != podID }
    if let source { lifetimes.removeValue(forKey: PodKey(source: source, podID: podID)) }
    // The separate key-level admission remains until its task settles, even when
    // a new record is created for an equal source/pod/decision after removal.
  }
}
