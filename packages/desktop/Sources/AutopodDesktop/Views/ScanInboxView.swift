import AutopodClient
import SwiftUI

struct ScanInboxView: View {
  let job: ScheduledJob
  let api: DaemonAPI
  @Environment(\.dismiss) private var dismiss
  @State private var reports: [ScheduledScanReport] = []
  @State private var detail: ScanReportDetail?
  @State private var reportId = ""
  @State private var selected: Set<String> = []
  @State private var reason = ""
  @State private var pending: ScanTriageRequest?
  @State private var error = ""
  @State private var message = ""
  @State private var busy = false
  @State private var baseRef = "main"
  @State private var headRef = "main"
  @State private var secrets = true
  @State private var dependencies = true
  @State private var judgment = false
  @State private var rollingWindow = false
  @State private var windowHours = 24

  private var draftKey: String { "autopod.scan-triage.\(api.baseURL.absoluteString).\(reportId)" }
  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack { Text("\(job.name) — Scan reports").font(.title2); Spacer(); Button("Done") { dismiss() } }
      if !error.isEmpty { Text(error).foregroundStyle(.red).textSelection(.enabled) }
      if !message.isEmpty { Text(message).textSelection(.enabled) }
      DisclosureGroup("Report-only scan policy") {
        VStack(alignment: .leading) {
          TextField("Base branch", text: $baseRef)
          TextField("Head branch", text: $headRef)
          Toggle("Rolling time window on one branch", isOn: $rollingWindow)
          if rollingWindow { Stepper("Last \(windowHours) hours (base and head must match)", value: $windowHours, in: 1...720) }
          HStack { Toggle("Secrets", isOn: $secrets); Toggle("Dependencies", isOn: $dependencies); Toggle("Bounded judgment", isOn: $judgment) }
          Text("The exact freshly fetched branch delta is collected. Empty deltas stay empty. npm dependency metadata goes to the public npm advisory service. Bounded judgment may incur configured provider cost.").font(.caption)
          Button("Save report-only policy") { Task { await savePolicy() } }.disabled(busy || (!secrets && !dependencies) || baseRef.isEmpty || headRef.isEmpty)
        }.textFieldStyle(.roundedBorder)
      }
      HStack {
        Picker("Report", selection: $reportId) {
          Text("Choose report").tag("")
          ForEach(reports) { report in Text("\(report.createdAt) · \(report.status)").tag(report.id) }
        }.disabled(busy)
        Button("Refresh") { Task { await refresh() } }.disabled(busy)
      }
      ScrollView {
        if let detail {
          VStack(alignment: .leading, spacing: 12) {
            Text(detail.report.status.replacingOccurrences(of: "_", with: " ")).font(.headline)
            Text("Report completion is separate from patch delivery.")
            Text("\(detail.report.policy.baseRef) → \(detail.report.policy.headRef)")
            if let collection = detail.report.collection {
              DisclosureGroup("Exact source and files") {
                Text(collection.repository)
                if let window = collection.window { Text("Window: \(window.start) → \(window.end) · \(window.selectedCommits.count) first-parent commits · net delta") }
                Text("Base: \(collection.baseSha ?? "unavailable")")
                Text("Head: \(collection.headSha ?? "unavailable")")
                ForEach(collection.files, id: \.path) { file in Text("\(file.change): \(file.path)") }
              }
              ForEach(collection.diagnostics, id: \.self) { Text($0) }
              ForEach(collection.scanners, id: \.scanner) { scanner in
                Text("\(scanner.scanner): \(scanner.status) · \(scanner.findingCount.map(String.init) ?? "Unknown") findings\(scanner.diagnostic.map { " · \($0)" } ?? "")")
              }
            }
            Text("Judgment: \(detail.report.judgment.status)")
            if let text = detail.report.judgment.text { Text(text) }
            if let usage = detail.report.judgment.usage {
              Text("\(usage.model) · \(usage.inputTokens + usage.outputTokens) tokens · cost \(usage.costUsd.map { String(format: "$%.4f", $0) } ?? "unavailable")").font(.caption)
            }
            Divider()
            Text("Unresolved findings (\(detail.unresolved.count))").font(.headline)
            Text("Includes earlier unresolved findings. A repair selection does not mark them fixed.")
            if let pending { Text("Decision retained for retry: \(pending.action)").foregroundStyle(.orange) }
            ForEach(detail.unresolved) { finding in
              Toggle(isOn: Binding(get: { selected.contains(finding.id) }, set: { value in
                if value { selected.insert(finding.id) } else { selected.remove(finding.id) }
              })) {
                VStack(alignment: .leading) {
                  Text("\(finding.severity) · \(finding.file)\(finding.line.map { ":\($0)" } ?? "")").fontWeight(.semibold)
                  Text(finding.summary)
                  Text("\(finding.disposition ?? "unresolved") · \(finding.id)").font(.caption)
                }
              }.toggleStyle(.checkbox).disabled(busy)
            }
            TextField("Reason for the decision", text: $reason, axis: .vertical).textFieldStyle(.roundedBorder).disabled(busy)
            HStack {
              Button("Defer") { Task { await triage("defer") } }
              Button("Record resolution") { Task { await triage("resolve") } }
              Button("Record repair selection") { Task { await triage("select_repair") } }
            }.disabled(busy || selected.isEmpty || reason.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            Divider()
            Text("Recorded decisions").font(.headline)
            ForEach(detail.decisions) { decision in
              VStack(alignment: .leading) {
                Text("\(decision.action) · \(decision.actor.displayName ?? decision.actor.userId ?? "unknown") · \(decision.createdAt)")
                Text(decision.reason)
                Text("\(decision.findingIds.count) selected findings")
                ForEach(decision.findingIds, id: \.self) { id in Text(detail.unresolved.first(where: { $0.id == id })?.file ?? id).font(.caption) }
                if let podId = decision.repairPodId { Text("Repair pod: \(podId) · dispatch receipt") }
                else if decision.action == "select_repair" {
                  Button("Launch selected repair") { Task { await launch(decision.id) } }.disabled(busy)
                }
              }.padding(.vertical, 4)
            }
          }.frame(maxWidth: .infinity, alignment: .leading).textSelection(.enabled)
        } else { Text("Select a report to review its durable findings and human decisions.") }
      }
    }.padding(20).frame(minWidth: 700, idealWidth: 820, minHeight: 600)
      .task {
        if let policy = job.scan {
          baseRef = policy.baseRef; headRef = policy.headRef
          secrets = policy.scanners.contains("secrets"); dependencies = policy.scanners.contains("dependencies")
          judgment = policy.judgment == "bounded"
          rollingWindow = policy.windowHours != nil; windowHours = policy.windowHours ?? 24
        }
        await refresh()
      }
      .task(id: reportId) { await loadDetail(restoreDraft: true) }
  }
  private func refresh() async {
    do { reports = try await api.listScanReports(job.id); if reportId.isEmpty { reportId = reports.first?.id ?? "" }; error = "" }
    catch { self.error = error.localizedDescription }
  }
  private func loadDetail(restoreDraft: Bool) async {
    guard !reportId.isEmpty else { detail = nil; return }
    let requested = reportId
    do {
      let loaded = try await api.getScanReport(requested)
      guard requested == reportId, !Task.isCancelled else { return }
      detail = loaded
      if restoreDraft {
        selected = []; reason = ""; pending = nil
        if let data = UserDefaults.standard.data(forKey: draftKey), let draft = try? JSONDecoder().decode(ScanTriageRequest.self, from: data) {
          pending = draft; selected = Set(draft.findingIds); reason = draft.reason
        }
      }
    } catch { self.error = error.localizedDescription }
  }
  private func savePolicy() async {
    busy = true; defer { busy = false }
    do {
      let scanners = (secrets ? ["secrets"] : []) + (dependencies ? ["dependencies"] : [])
      _ = try await api.updateScheduledJob(job.id, UpdateScheduledJobRequest(scan: ScheduledScanPolicy(baseRef: baseRef, headRef: headRef, scanners: scanners, judgment: judgment ? "bounded" : "none", windowHours: rollingWindow ? windowHours : nil)))
      message = "Report-only policy saved. The schedule's enabled state is unchanged."; error = ""
    } catch { self.error = error.localizedDescription }
  }
  private func triage(_ action: String) async {
    busy = true; defer { busy = false }
    let ids = selected.sorted(); let trimmed = reason.trimmingCharacters(in: .whitespacesAndNewlines)
    let reuse = pending?.action == action && pending?.findingIds == ids && pending?.reason == trimmed
    let request = ScanTriageRequest(requestKey: reuse ? (pending?.requestKey ?? UUID().uuidString) : UUID().uuidString, findingIds: ids, action: action, reason: trimmed)
    do {
      UserDefaults.standard.set(try JSONEncoder().encode(request), forKey: draftKey); pending = request
      _ = try await api.triageScanReport(reportId, request)
      await loadDetail(restoreDraft: false)
      UserDefaults.standard.removeObject(forKey: draftKey); pending = nil; selected = []; reason = ""
      message = action == "select_repair" ? "Selection recorded. Review it before launching a repair." : "Decision recorded."; error = ""
    } catch { self.error = "\(error.localizedDescription). The decision is retained for retry." }
  }
  private func launch(_ selectionId: String) async {
    busy = true; defer { busy = false }
    do {
      let receipt = try await api.launchScanRepair(reportId, selectionId: selectionId)
      await loadDetail(restoreDraft: false)
      message = "Repair pod \(receipt.podId) recorded. Delivery remains unverified."; error = ""
    } catch { self.error = error.localizedDescription }
  }
}
