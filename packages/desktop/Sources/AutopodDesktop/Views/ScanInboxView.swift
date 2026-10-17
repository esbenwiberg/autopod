import AutopodClient
import AutopodUI
import SwiftUI

struct ScanInboxView: View {
  let job: ScheduledJob
  let api: any ScanInboxAPI
  var embedded = false
  var onClose: (() -> Void)? = nil
  @Environment(\.desktopRedesign) private var redesign
  @Environment(\.desktopWorkspaceDirty) private var workspaceDirty
  @Environment(\.desktopWorkspaceBusy) private var workspaceBusy
  @State private var section = "Findings"
  @State private var policyOpen = false
  @State private var savedPolicyKey: String?
  @State private var confirmClose = false
  @State private var repairToLaunch: String?
  @Environment(\.dismiss) private var dismiss
  @State private var reports: [ScanReportSummary] = []
  @State private var nextCursor: String?
  @State private var pageGeneration = 0
  @State private var loadingReports = false
  @State private var reviewGeneration = 0
  @State private var loadingReviewPage = false
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

  init(job: ScheduledJob, api: any ScanInboxAPI, embedded: Bool = false,
       onClose: (() -> Void)? = nil, initialReports: [ScanReportSummary] = [],
       initialDetail: ScanReportDetail? = nil, initialSection: String = "Findings",
       showPolicy: Bool = false) {
    self.job = job; self.api = api; self.embedded = embedded; self.onClose = onClose
    _reports = State(initialValue: initialReports); _detail = State(initialValue: initialDetail)
    _reportId = State(initialValue: initialDetail?.report.id ?? "")
    _section = State(initialValue: initialSection); _policyOpen = State(initialValue: showPolicy)
    if let policy = job.scan {
      _baseRef = State(initialValue: policy.baseRef); _headRef = State(initialValue: policy.headRef)
      _secrets = State(initialValue: policy.scanners.contains("secrets"))
      _dependencies = State(initialValue: policy.scanners.contains("dependencies"))
      _judgment = State(initialValue: policy.judgment == "bounded")
      _rollingWindow = State(initialValue: policy.windowHours != nil)
      _windowHours = State(initialValue: policy.windowHours ?? 24)
    }
  }
  private var policyCanSave: Bool {
    !baseRef.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
      && !headRef.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
      && (secrets || dependencies) && !sameBranchWithoutWindow
      && (!rollingWindow || (baseRef == headRef && (1...720).contains(windowHours)))
  }
  private func setBusy(_ value: Bool) { busy = value; workspaceBusy?(value) }
  private var sameBranchWithoutWindow: Bool { !rollingWindow && baseRef == headRef }
  private var draftKey: String { "autopod.scan-triage.\(api.baseURL.absoluteString).\(reportId)" }
  private var policyKey: String {
    "\(baseRef)|\(headRef)|\(rollingWindow)|\(windowHours)|\(secrets)|\(dependencies)|\(judgment)"
  }
  private var policyDirty: Bool { savedPolicyKey != nil && savedPolicyKey != policyKey }
  private var useWorkspace: Bool { embedded && redesign }
  var body: some View {
    Group { if useWorkspace { workspace } else { legacyBody } }
      .onChange(of: busy) { _, value in workspaceBusy?(value) }
      .onChange(of: policyKey) { _, _ in workspaceDirty?(policyDirty) }
      .onDisappear { workspaceBusy?(false); workspaceDirty?(false) }
      .confirmationDialog("Discard unsaved scan policy?", isPresented: $confirmClose) {
        Button("Discard changes", role: .destructive) { workspaceDirty?(false); close() }
        Button("Keep editing", role: .cancel) {}
      }
      .confirmationDialog("Launch selected repair?", isPresented: Binding(get: { repairToLaunch != nil }, set: { if !$0 { repairToLaunch = nil } })) {
        Button("Launch repair") { if let id = repairToLaunch { repairToLaunch = nil; Task { await launch(id) } } }
        Button("Cancel", role: .cancel) { repairToLaunch = nil }
      } message: { Text("This dispatches a repair pod for the recorded selection. Findings remain unresolved until a human records their resolution.") }
      .task {
        if let policy = job.scan {
          baseRef = policy.baseRef; headRef = policy.headRef
          secrets = policy.scanners.contains("secrets"); dependencies = policy.scanners.contains("dependencies")
          judgment = policy.judgment == "bounded"
          rollingWindow = policy.windowHours != nil; windowHours = policy.windowHours ?? 24
        }
        savedPolicyKey = policyKey
        await refresh()
      }
      .task(id: reportId) { await loadDetail(restoreDraft: true) }
  }
  private func close() { if let onClose { onClose() } else { dismiss() } }
  private func requestClose() { guard !busy else { return }; if policyDirty { confirmClose = true } else { close() } }

  private var workspace: some View {
    VStack(spacing: 0) {
      HStack {
        VStack(alignment: .leading, spacing: 8) {
          Button("‹ Schedules", action: requestClose).buttonStyle(.plain).foregroundStyle(.secondary)
          Text(job.name).font(.title2.weight(.semibold))
          Text("Report-only scans · report completion is separate from patch delivery.").font(.caption).foregroundStyle(.secondary)
        }
        Spacer()
        if policyOpen { Button("Back to reports") { policyOpen = false } }
        else { Button("Scan policy") { policyOpen = true } }
        Button { Task { await refresh() } } label: { Image(systemName: "arrow.clockwise") }.disabled(busy || loadingReports)
      }.padding(24).background(DesktopTheme.surface)
      Divider()
      if !error.isEmpty { Text(error).foregroundStyle(.red).textSelection(.enabled).padding(12).frame(maxWidth: .infinity, alignment: .leading) }
      if !message.isEmpty { Text(message).font(.callout).textSelection(.enabled).padding(12).frame(maxWidth: .infinity, alignment: .leading) }
      if policyOpen {
        ScrollView { VStack(alignment: .leading, spacing: 20) {
          Text("Source & collection").font(.title3.weight(.semibold))
          Text(policyDirty ? "Unsaved policy changes" : "Current scan policy").font(.caption).foregroundStyle(.secondary)
          policyControls
        }.padding(28).frame(maxWidth: 1000, alignment: .leading) }
      } else {
        GeometryReader { geometry in
        HSplitView {
          reportList.frame(minWidth: 180, idealWidth: 225, maxWidth: 300)
          VStack(spacing: 0) {
            reportTabs
            Divider()
            ScrollView {
              if let detail, detail.report.id == reportId {
                VStack(alignment: .leading, spacing: 20) {
                  reportSummary(detail)
                  switch section {
                  case "Source & scanners": sourceEvidence(detail)
                  case "Judgment": judgmentEvidence(detail)
                  case "Decisions": decisionsView(detail)
                  default: findingList(detail)
                  }
                  if geometry.size.width < 1100 {
                    Divider()
                    Text("Record a decision").font(.headline)
                    triageControls(detail)
                    Text("Recording a selection does not launch a pod. Launch separately in Decisions.").font(.caption).foregroundStyle(.secondary)
                  }
                }.padding(24).frame(maxWidth: .infinity, alignment: .leading).textSelection(.enabled)
              } else { ContentUnavailableView("Choose a report", systemImage: "doc.text.magnifyingglass", description: Text("Review durable findings, evidence and human decisions.")) }
            }
          }.frame(minWidth: 360, maxWidth: .infinity)
          if geometry.size.width >= 1100, let detail, detail.report.id == reportId {
            ScrollView {
              VStack(alignment: .leading, spacing: 16) {
                Text("HUMAN REVIEW").font(.caption2).foregroundStyle(.secondary)
                Text("Record a decision").font(.headline)
                triageControls(detail)
                Text("Recording a repair selection does not launch a pod. Review it in Decisions, then launch separately.")
                  .font(.caption).foregroundStyle(.secondary)
              }.padding(20)
            }.frame(minWidth: 235, idealWidth: 270, maxWidth: 320).background(DesktopTheme.canvas)
          }
        }
      }
    }
    }.background(DesktopTheme.surface)
      .disabled(busy)
  }
  private var reportTabs: some View {
    ViewThatFits(in: .horizontal) {
      HStack { tabButtons }
      ScrollView(.horizontal) { HStack { tabButtons } }
    }.padding(12)
  }
  @ViewBuilder private var tabButtons: some View {
    ForEach(["Findings", "Source & scanners", "Judgment", "Decisions"], id: \.self) { item in
      Button { section = item } label: {
        Text(item).font(.caption).fixedSize().padding(8)
          .foregroundStyle(section == item ? DesktopTheme.accent : .secondary)
          .background(section == item ? DesktopTheme.selection : .clear, in: RoundedRectangle(cornerRadius: 5))
      }.buttonStyle(.plain)
    }
  }
  private var reportList: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 12) {
        Text("Scan reports").font(.headline)
        ForEach(reports) { report in
          Button { reportId = report.id } label: {
            VStack(alignment: .leading, spacing: 8) {
              Text(DesktopScheduleTime.label(report.createdAt)).font(.caption)
              Text(report.status.replacingOccurrences(of: "_", with: " ")).font(.caption.weight(.semibold))
              if let count = report.findingCount { Text("\(count) recorded findings").font(.caption2).foregroundStyle(.secondary) }
            }.padding(12).frame(maxWidth: .infinity, alignment: .leading)
              .background(report.id == reportId ? DesktopTheme.selection : DesktopTheme.canvas, in: RoundedRectangle(cornerRadius: 7))
              .overlay(RoundedRectangle(cornerRadius: 7).stroke(DesktopTheme.line))
          }.buttonStyle(.plain).disabled(busy)
        }
        if reports.isEmpty { Text(loadingReports ? "Loading reports…" : "No reports yet.").foregroundStyle(.secondary) }
        if nextCursor != nil { Button("Load older reports") { Task { await loadOlderReports() } }.disabled(busy || loadingReports) }
        Text("Report completion is separate from patch delivery.").font(.caption).foregroundStyle(.secondary)
      }.padding(16)
    }.background(DesktopTheme.canvas)
  }
  private var policyControls: some View {
    VStack(alignment: .leading, spacing: 22) {
      VStack(alignment: .leading, spacing: 16) {
        Text("Source range").font(.headline)
        LabeledContent("Base branch") {
          TextField("Base branch", text: $baseRef).accessibilityLabel("Base branch").frame(maxWidth: 400)
        }
        LabeledContent("Head branch") {
          TextField("Head branch", text: $headRef).accessibilityLabel("Head branch").frame(maxWidth: 400)
        }
        Toggle("Rolling time window on one branch", isOn: $rollingWindow)
        if rollingWindow {
          Stepper("Last \(windowHours) hours (base and head must match)", value: $windowHours, in: 1...720)
        }
        Text("The exact freshly fetched branch delta is collected. Empty deltas stay empty.")
          .font(.caption).foregroundStyle(.secondary)
        if sameBranchWithoutWindow {
          Text("Base and head are the same branch. Turn on the rolling time window to scan recent commits.")
            .font(.caption).foregroundStyle(.orange)
        }
        if rollingWindow && baseRef != headRef {
          Text("A rolling time window requires the same base and head branch.").font(.caption).foregroundStyle(.orange)
        }
      }.padding(20).frame(maxWidth: .infinity, alignment: .leading)
        .background(DesktopTheme.canvas, in: RoundedRectangle(cornerRadius: 8))
      VStack(alignment: .leading, spacing: 16) {
        Text("Scanners & judgment").font(.headline)
        Toggle("Secrets", isOn: $secrets)
        Toggle("Dependencies", isOn: $dependencies)
        Text("npm dependency metadata goes to the public npm advisory service.").font(.caption).foregroundStyle(.secondary)
        Divider()
        Toggle("Bounded judgment", isOn: $judgment)
        Text("Bounded judgment may incur configured provider cost.").font(.caption).foregroundStyle(.secondary)
      }.padding(20).frame(maxWidth: .infinity, alignment: .leading)
        .background(DesktopTheme.canvas, in: RoundedRectangle(cornerRadius: 8))
      HStack {
        Text("The schedule’s enabled state is unchanged.").font(.caption).foregroundStyle(.secondary)
        Spacer()
        Button("Save report-only policy") { Task { await savePolicy() } }
          .buttonStyle(.borderedProminent).disabled(busy || !policyCanSave)
      }
    }.textFieldStyle(.roundedBorder)
  }
  private func reportSummary(_ detail: ScanReportDetail) -> some View {
    let unavailable = !(detail.report.evidenceDiagnostics ?? []).isEmpty
    return VStack(alignment: .leading, spacing: 14) {
            Text(unavailable ? "Report evidence unavailable" : detail.report.status.replacingOccurrences(of: "_", with: " ").capitalized).font(.headline)
            if unavailable {
              Text("Recorded status: \(detail.report.status). A clean result cannot be verified.")
              ForEach(detail.report.evidenceDiagnostics ?? [], id: \.self) { Text($0) }
            }
            if detail.report.status == "empty_delta" {
              Text("No changes in the scanned range. No files were checked; this is not a clean-scan verdict.").foregroundStyle(.secondary)
            }
            if let policy = detail.report.policy { Text("\(policy.baseRef) → \(policy.headRef)") } else { Text("Policy unavailable") }

    }.padding(18).frame(maxWidth: .infinity, alignment: .leading)
      .background(DesktopTheme.canvas, in: RoundedRectangle(cornerRadius: 8))
  }
  private func sourceEvidence(_ detail: ScanReportDetail) -> some View {
    return VStack(alignment: .leading, spacing: 14) {
            if let collection = detail.report.collection {
              DisclosureGroup("Exact source and files", isExpanded: .constant(true)) {
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

    }.padding(18).frame(maxWidth: .infinity, alignment: .leading)
      .background(DesktopTheme.canvas, in: RoundedRectangle(cornerRadius: 8))
  }
  private func judgmentEvidence(_ detail: ScanReportDetail) -> some View {
    return VStack(alignment: .leading, spacing: 14) {
            Text("Judgment: \(detail.report.judgment?.status ?? "unavailable")")
            if let text = detail.report.judgment?.text { Text(text) }
            if let usage = detail.report.judgment?.usage {
              Text("\(usage.model) · \(usage.inputTokens + usage.outputTokens) recorded tokens · cost \(usage.costUsd.map { String(format: "$%.4f", $0) } ?? "unavailable")").font(.caption)
            }

    }
  }
  private func findingList(_ detail: ScanReportDetail) -> some View {
    let unavailable = !(detail.report.evidenceDiagnostics ?? []).isEmpty
    let scopeUnavailable = detail.report.collection == nil || detail.report.collection?.repository == "unavailable"
    return VStack(alignment: .leading, spacing: 14) {
            if let diagnostics = detail.diagnostics, !diagnostics.isEmpty {
              Text("Some review records are unavailable").font(.headline)
              Text("Loaded counts exclude these records. They remain stored and have not been resolved.")
              ForEach(diagnostics, id: \.self) { item in Text("\(item.recordId) · \(item.message)") }
            }
            Text("Unresolved findings (\(detail.unresolved.count) loaded)").font(.headline)
            Text("Includes earlier unresolved findings. A repair selection does not mark them fixed.")
            if let pending { Text("Decision retained for retry: \(pending.action)").foregroundStyle(.orange) }
            if (detail.diagnostics ?? []).contains(where: { $0.kind == "finding" && selected.contains($0.recordId) }) {
              Button("Remove unavailable selections") {
                let unavailable = Set((detail.diagnostics ?? []).filter { $0.kind == "finding" }.map(\.recordId))
                selected.subtract(unavailable); pending = nil; UserDefaults.standard.removeObject(forKey: draftKey)
                message = "Unavailable selections removed from this local draft. Recorded decisions remain in history."
              }.disabled(busy)
            }
            ForEach(detail.unresolved) { finding in
              Toggle(isOn: Binding(get: { selected.contains(finding.id) }, set: { value in
                if value { selected.insert(finding.id) } else { selected.remove(finding.id) }
              })) {
                VStack(alignment: .leading) {
                  Text("\(finding.severity) · \(finding.file)\(finding.line.map { ":\($0)" } ?? "")").fontWeight(.semibold)
                  Text(finding.summary)
                  Text("\(finding.disposition ?? "unresolved") · \(finding.id)").font(.caption)
                }
              }.padding(14).frame(maxWidth: .infinity, alignment: .leading)
                .background(DesktopTheme.canvas, in: RoundedRectangle(cornerRadius: 7))
                .overlay(RoundedRectangle(cornerRadius: 7).stroke(DesktopTheme.line))
                .toggleStyle(.checkbox).disabled(busy || unavailable || scopeUnavailable || (selected.count >= 100 && !selected.contains(finding.id)))
            }
            if detail.unresolvedNextCursor != nil { Button("Load more findings") { Task { await loadReviewPage(findings: true) } }.disabled(busy || loadingReviewPage) }

    }
  }
  private func triageControls(_ detail: ScanReportDetail) -> some View {
    let unavailable = !(detail.report.evidenceDiagnostics ?? []).isEmpty
    let scopeUnavailable = detail.report.collection == nil || detail.report.collection?.repository == "unavailable"
    return VStack(alignment: .leading, spacing: 14) {
            Text("\(selected.count) / 100 findings selected")
            TextField("Reason for the decision", text: $reason, axis: .vertical).lineLimit(4...8).textFieldStyle(.roundedBorder).accessibilityLabel("Reason for the decision").disabled(busy)
            VStack(alignment: .leading, spacing: 10) {
              Button("Defer") { Task { await triage("defer") } }.frame(maxWidth: .infinity)
              Button("Record resolution") { Task { await triage("resolve") } }.frame(maxWidth: .infinity)
              Button("Record repair selection") { Task { await triage("select_repair") } }.buttonStyle(.borderedProminent).frame(maxWidth: .infinity)
            }.disabled(busy || unavailable || scopeUnavailable || selected.isEmpty || (detail.diagnostics ?? []).contains(where: { $0.kind == "finding" && selected.contains($0.recordId) }) || reason.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)

    }
  }
  private func decisionsView(_ detail: ScanReportDetail) -> some View {
    let unavailable = !(detail.report.evidenceDiagnostics ?? []).isEmpty
    let scopeUnavailable = detail.report.collection == nil || detail.report.collection?.repository == "unavailable"
    return VStack(alignment: .leading, spacing: 14) {
            Text("Recorded decisions").font(.headline)
            if detail.decisions.isEmpty { Text("No decisions recorded. Select findings and provide a reason to record one.").font(.callout).foregroundStyle(.secondary) }
            ForEach(detail.decisions) { decision in
              VStack(alignment: .leading) {
                Text("\(decision.action) · \(decision.actor.displayName ?? decision.actor.userId ?? "unknown") · \(decision.createdAt)")
                Text(decision.reason)
                Text("\(decision.findingIds.count) selected findings")
                ForEach(decision.findingIds, id: \.self) { id in Text(detail.unresolved.first(where: { $0.id == id })?.file ?? id).font(.caption) }
                if let podId = decision.repairPodId { Text("Repair pod: \(podId) · dispatch receipt") }
                else if decision.action == "select_repair" {
                  Button("Launch selected repair") { repairToLaunch = decision.id }.disabled(busy || unavailable || scopeUnavailable || (detail.diagnostics ?? []).contains(where: { $0.kind == "finding" && decision.findingIds.contains($0.recordId) }))
                }
              }.padding(.vertical, 4)
            }
            if detail.decisionsNextCursor != nil { Button("Load older decisions") { Task { await loadReviewPage(findings: false) } }.disabled(busy || loadingReviewPage) }
    }
  }
  private var legacyBody: some View {
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
          if sameBranchWithoutWindow { Text("Base and head are the same branch, so the delta is always empty. Turn on the rolling time window to scan recent commits.").font(.caption).foregroundStyle(.orange) }
          Button("Save report-only policy") { Task { await savePolicy() } }.disabled(busy || !policyCanSave)
        }.textFieldStyle(.roundedBorder)
      }
      HStack {
        Picker("Report", selection: $reportId) {
          Text("Choose report").tag("")
          ForEach(reports) { report in Text("\(report.createdAt) · \(report.status)").tag(report.id) }
        }.disabled(busy)
        Button("Refresh") { Task { await refresh() } }.disabled(busy || loadingReports)
        if nextCursor != nil { Button("Load older reports") { Task { await loadOlderReports() } }.disabled(busy || loadingReports) }
      }
      ScrollView {
        if let detail, detail.report.id == reportId {
          VStack(alignment: .leading, spacing: 12) {
            let unavailable = !(detail.report.evidenceDiagnostics ?? []).isEmpty
            let scopeUnavailable = detail.report.collection == nil || detail.report.collection?.repository == "unavailable"
            Text(unavailable ? "Report evidence unavailable" : detail.report.status.replacingOccurrences(of: "_", with: " ")).font(.headline)
            if unavailable {
              Text("Recorded status: \(detail.report.status). A clean result cannot be verified.")
              ForEach(detail.report.evidenceDiagnostics ?? [], id: \.self) { Text($0) }
            }
            Text("Report completion is separate from patch delivery.")
            if let policy = detail.report.policy { Text("\(policy.baseRef) → \(policy.headRef)") } else { Text("Policy unavailable") }
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
            Text("Judgment: \(detail.report.judgment?.status ?? "unavailable")")
            if let text = detail.report.judgment?.text { Text(text) }
            if let usage = detail.report.judgment?.usage {
              Text("\(usage.model) · \(usage.inputTokens + usage.outputTokens) recorded tokens · cost \(usage.costUsd.map { String(format: "$%.4f", $0) } ?? "unavailable")").font(.caption)
            }
            Divider()
            if let diagnostics = detail.diagnostics, !diagnostics.isEmpty {
              Text("Some review records are unavailable").font(.headline)
              Text("Loaded counts exclude these records. They remain stored and have not been resolved.")
              ForEach(diagnostics, id: \.self) { item in Text("\(item.recordId) · \(item.message)") }
            }
            Text("Unresolved findings (\(detail.unresolved.count) loaded)").font(.headline)
            Text("Includes earlier unresolved findings. A repair selection does not mark them fixed.")
            if let pending { Text("Decision retained for retry: \(pending.action)").foregroundStyle(.orange) }
            if (detail.diagnostics ?? []).contains(where: { $0.kind == "finding" && selected.contains($0.recordId) }) {
              Button("Remove unavailable selections") {
                let unavailable = Set((detail.diagnostics ?? []).filter { $0.kind == "finding" }.map(\.recordId))
                selected.subtract(unavailable); pending = nil; UserDefaults.standard.removeObject(forKey: draftKey)
                message = "Unavailable selections removed from this local draft. Recorded decisions remain in history."
              }.disabled(busy)
            }
            ForEach(detail.unresolved) { finding in
              Toggle(isOn: Binding(get: { selected.contains(finding.id) }, set: { value in
                if value { selected.insert(finding.id) } else { selected.remove(finding.id) }
              })) {
                VStack(alignment: .leading) {
                  Text("\(finding.severity) · \(finding.file)\(finding.line.map { ":\($0)" } ?? "")").fontWeight(.semibold)
                  Text(finding.summary)
                  Text("\(finding.disposition ?? "unresolved") · \(finding.id)").font(.caption)
                }
              }.toggleStyle(.checkbox).disabled(busy || unavailable || scopeUnavailable || (selected.count >= 100 && !selected.contains(finding.id)))
            }
            if detail.unresolvedNextCursor != nil { Button("Load more findings") { Task { await loadReviewPage(findings: true) } }.disabled(busy || loadingReviewPage) }
            Text("\(selected.count) / 100 findings selected")
            TextField("Reason for the decision", text: $reason, axis: .vertical).textFieldStyle(.roundedBorder).disabled(busy)
            HStack {
              Button("Defer") { Task { await triage("defer") } }
              Button("Record resolution") { Task { await triage("resolve") } }
              Button("Record repair selection") { Task { await triage("select_repair") } }
            }.disabled(busy || unavailable || scopeUnavailable || selected.isEmpty || (detail.diagnostics ?? []).contains(where: { $0.kind == "finding" && selected.contains($0.recordId) }) || reason.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
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
                  Button("Launch selected repair") { Task { await launch(decision.id) } }.disabled(busy || unavailable || scopeUnavailable || (detail.diagnostics ?? []).contains(where: { $0.kind == "finding" && decision.findingIds.contains($0.recordId) }))
                }
              }.padding(.vertical, 4)
            }
            if detail.decisionsNextCursor != nil { Button("Load older decisions") { Task { await loadReviewPage(findings: false) } }.disabled(busy || loadingReviewPage) }
          }.frame(maxWidth: .infinity, alignment: .leading).textSelection(.enabled)
        } else { Text("Select a report to review its durable findings and human decisions.") }
      }
    }.padding(20).frame(minWidth: 700, idealWidth: 820, minHeight: 600)

  }
  private func refresh() async {
    pageGeneration += 1; let owner = pageGeneration
    loadingReports = true
    defer { if owner == pageGeneration { loadingReports = false } }
    do {
      let page = try await api.listScanReportPage(job.id, before: nil)
      guard owner == pageGeneration, !Task.isCancelled else { return }
      reports = page.items; nextCursor = page.nextCursor
      if reportId.isEmpty { reportId = reports.first?.id ?? "" }; error = ""
    } catch { if owner == pageGeneration { self.error = error.localizedDescription } }
  }
  private func loadOlderReports() async {
    guard let cursor = nextCursor, !loadingReports else { return }
    let owner = pageGeneration; loadingReports = true
    defer { if owner == pageGeneration { loadingReports = false } }
    do {
      let page = try await api.listScanReportPage(job.id, before: cursor)
      guard owner == pageGeneration, !Task.isCancelled else { return }
      let existing = Set(reports.map(\.id))
      reports.append(contentsOf: page.items.filter { !existing.contains($0.id) })
      nextCursor = page.nextCursor; error = ""
    } catch { if owner == pageGeneration { self.error = error.localizedDescription } }
  }
  private func loadDetail(restoreDraft: Bool) async {
    guard !reportId.isEmpty else { detail = nil; return }
    let requested = reportId
    reviewGeneration += 1; let owner = reviewGeneration; loadingReviewPage = false
    do {
      let loaded = try await api.getScanReportReview(requested)
      guard requested == reportId, owner == reviewGeneration, !Task.isCancelled else { return }
      detail = loaded
      if restoreDraft {
        selected = []; reason = ""; pending = nil
        if let data = UserDefaults.standard.data(forKey: draftKey), let draft = try? JSONDecoder().decode(ScanTriageRequest.self, from: data) {
          pending = draft; selected = Set(draft.findingIds); reason = draft.reason
        }
      }
    } catch { if requested == reportId, owner == reviewGeneration { self.error = error.localizedDescription } }
  }
  private func loadReviewPage(findings: Bool) async {
    guard let cursor = findings ? detail?.unresolvedNextCursor : detail?.decisionsNextCursor, !loadingReviewPage, !busy else { return }
    let requested = reportId; let owner = reviewGeneration; loadingReviewPage = true
    defer { if owner == reviewGeneration { loadingReviewPage = false } }
    do {
      if findings {
        let page = try await api.getScanFindings(requested, after: cursor)
        guard owner == reviewGeneration, requested == reportId, !Task.isCancelled else { return }
        let existing = Set(detail?.unresolved.map(\.id) ?? [])
        detail?.unresolved.append(contentsOf: page.items.filter { !existing.contains($0.id) }); detail?.unresolvedNextCursor = page.nextCursor
        detail?.diagnostics = (detail?.diagnostics ?? []) + (page.diagnostics ?? [])
      } else {
        let page = try await api.getScanDecisions(requested, before: cursor)
        guard owner == reviewGeneration, requested == reportId, !Task.isCancelled else { return }
        let existing = Set(detail?.decisions.map(\.id) ?? [])
        detail?.decisions.append(contentsOf: page.items.filter { !existing.contains($0.id) }); detail?.decisionsNextCursor = page.nextCursor
        detail?.diagnostics = (detail?.diagnostics ?? []) + (page.diagnostics ?? [])
      }
    } catch { if owner == reviewGeneration { self.error = error.localizedDescription } }
  }
  private func savePolicy() async {
    setBusy(true); defer { setBusy(false) }
    do {
      let scanners = (secrets ? ["secrets"] : []) + (dependencies ? ["dependencies"] : [])
      _ = try await api.updateScheduledJob(job.id, UpdateScheduledJobRequest(scan: ScheduledScanPolicy(baseRef: baseRef, headRef: headRef, scanners: scanners, judgment: judgment ? "bounded" : "none", windowHours: rollingWindow ? windowHours : nil)))
      savedPolicyKey = policyKey; workspaceDirty?(false)
      message = "Report-only policy saved. The schedule's enabled state is unchanged."; error = ""
    } catch { self.error = error.localizedDescription }
  }
  private func triage(_ action: String) async {
    setBusy(true); defer { setBusy(false) }
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
    setBusy(true); defer { setBusy(false) }
    do {
      let receipt = try await api.launchScanRepair(reportId, selectionId: selectionId)
      await loadDetail(restoreDraft: false)
      message = "Repair pod \(receipt.podId) recorded. Delivery remains unverified."; error = ""
    } catch { self.error = error.localizedDescription }
  }
}
