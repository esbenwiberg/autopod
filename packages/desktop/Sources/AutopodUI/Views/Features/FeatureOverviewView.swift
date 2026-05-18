import SwiftUI

/// High-level overview of Autopod capabilities — visual feature cards with key highlights.
public struct FeatureOverviewView: View {
    @State private var hoveredFeature: String?
    @Binding public var selectedFeature: FeatureCategory?

    public init(selectedFeature: Binding<FeatureCategory?>) {
        self._selectedFeature = selectedFeature
    }

    public var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 28) {
                hero
                featureGrid
                lifecycleBanner
                architectureDiagram
            }
            .padding(28)
        }
        .background(Color(nsColor: .windowBackgroundColor))
    }

    // MARK: - Hero

    private var hero: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 10) {
                Image(systemName: "server.rack")
                    .font(.system(size: 28))
                    .foregroundStyle(.blue)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Autopod")
                        .font(.title.weight(.bold))
                    Text("Autonomous AI pod orchestration platform")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
            }

            Text("Autopod provisions isolated containers, runs AI coding agents, validates their output, and manages the full lifecycle from task to merged PR — with human oversight at every critical step.")
                .font(.body)
                .foregroundStyle(.secondary)
                .lineSpacing(3)
                .padding(.top, 4)
        }
    }

    // MARK: - Feature grid

    private var featureGrid: some View {
        LazyVGrid(
            columns: [GridItem(.adaptive(minimum: 260), spacing: 14)],
            alignment: .leading,
            spacing: 14
        ) {
            ForEach(FeatureCategory.allCases) { feature in
                featureCard(feature)
            }
        }
    }

    private func featureCard(_ feature: FeatureCategory) -> some View {
        let isHovered = hoveredFeature == feature.id

        return VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Image(systemName: feature.icon)
                    .font(.system(size: 16))
                    .foregroundStyle(feature.color)
                    .frame(width: 28, height: 28)
                    .background(feature.color.opacity(0.12))
                    .clipShape(RoundedRectangle(cornerRadius: 6))

                Text(feature.title)
                    .font(.headline)
            }

            Text(feature.summary)
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineSpacing(2)
                .lineLimit(3)

            Divider()

            HStack(spacing: 6) {
                ForEach(feature.highlights, id: \.self) { tag in
                    Text(tag)
                        .font(.system(.caption2).weight(.medium))
                        .padding(.horizontal, 7)
                        .padding(.vertical, 3)
                        .background(feature.color.opacity(0.08))
                        .foregroundStyle(feature.color)
                        .clipShape(Capsule())
                }
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(nsColor: .controlBackgroundColor))
        .clipShape(RoundedRectangle(cornerRadius: 10))
        .shadow(
            color: .black.opacity(isHovered ? 0.08 : 0.02),
            radius: isHovered ? 8 : 3
        )
        .overlay(
            RoundedRectangle(cornerRadius: 10)
                .stroke(
                    selectedFeature == feature
                        ? feature.color.opacity(0.6)
                        : isHovered ? feature.color.opacity(0.35) : .clear,
                    lineWidth: selectedFeature == feature ? 2 : 1.5
                )
        )
        .scaleEffect(isHovered ? 1.01 : 1.0)
        .animation(.easeOut(duration: 0.15), value: isHovered)
        .onHover { hovering in hoveredFeature = hovering ? feature.id : nil }
        .onTapGesture { selectedFeature = feature }
    }

    // MARK: - Lifecycle banner

    private var lifecycleBanner: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Pod Lifecycle")
                .font(.subheadline.weight(.semibold))

            // Flow diagram
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 0) {
                    ForEach(Array(lifecycleSteps.enumerated()), id: \.offset) { index, step in
                        HStack(spacing: 0) {
                            lifecycleStep(step.icon, step.label, step.color)
                            if index < lifecycleSteps.count - 1 {
                                Image(systemName: "chevron.right")
                                    .font(.system(size: 9))
                                    .foregroundStyle(.tertiary)
                                    .padding(.horizontal, 4)
                            }
                        }
                    }
                }
            }

            Text("Every pod follows this pipeline. Failed steps can retry automatically, and human review gates ensure quality before merge.")
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineSpacing(2)
        }
        .padding(16)
        .background(Color(nsColor: .controlBackgroundColor))
        .clipShape(RoundedRectangle(cornerRadius: 10))
    }

    private func lifecycleStep(_ icon: String, _ label: String, _ color: Color) -> some View {
        VStack(spacing: 4) {
            Image(systemName: icon)
                .font(.system(size: 12))
                .foregroundStyle(color)
                .frame(width: 28, height: 28)
                .background(color.opacity(0.1))
                .clipShape(Circle())
            Text(label)
                .font(.system(.caption2).weight(.medium))
                .foregroundStyle(.secondary)
        }
    }

    // MARK: - Architecture diagram

    private var architectureDiagram: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Architecture")
                .font(.subheadline.weight(.semibold))

            HStack(spacing: 16) {
                archComponent("Desktop / CLI", icon: "display", desc: "Monitor & control", color: .blue)
                archArrow
                archComponent("Daemon", icon: "server.rack", desc: "Orchestration & API", color: .purple)
                archArrow
                archComponent("Containers", icon: "shippingbox", desc: "Isolated agents", color: .green)
            }
            .frame(maxWidth: .infinity)

            HStack(spacing: 16) {
                archComponent("Profiles", icon: "folder", desc: "Config & credentials", color: .orange)
                archArrow
                archComponent("Runtimes", icon: "cpu", desc: "Claude, Codex, Copilot", color: .cyan)
                archArrow
                archComponent("Validation", icon: "checkmark.shield", desc: "Smoke, tests, review", color: .mint)
            }
            .frame(maxWidth: .infinity)
        }
        .padding(16)
        .background(Color(nsColor: .controlBackgroundColor))
        .clipShape(RoundedRectangle(cornerRadius: 10))
    }

    private func archComponent(_ title: String, icon: String, desc: String, color: Color) -> some View {
        VStack(spacing: 6) {
            Image(systemName: icon)
                .font(.system(size: 14))
                .foregroundStyle(color)
                .frame(width: 32, height: 32)
                .background(color.opacity(0.1))
                .clipShape(RoundedRectangle(cornerRadius: 7))
            Text(title)
                .font(.system(.caption).weight(.semibold))
            Text(desc)
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
    }

    private var archArrow: some View {
        Image(systemName: "arrow.right")
            .font(.system(size: 10))
            .foregroundStyle(.quaternary)
    }

    // MARK: - Data

    private var lifecycleSteps: [(icon: String, label: String, color: Color)] {
        [
            ("tray.full", "Queued", .gray),
            ("shippingbox", "Provision", .blue),
            ("play.fill", "Running", .blue),
            ("checkmark.shield", "Validate", .cyan),
            ("exclamationmark.triangle", "Review Req.", .red),
            ("person.fill.checkmark", "Approved", .orange),
            ("clock.badge", "Merge Pend.", .indigo),
            ("arrow.triangle.merge", "Merge", .purple),
            ("checkmark.circle.fill", "Complete", .green),
        ]
    }
}

// MARK: - Feature categories

public enum FeatureCategory: String, CaseIterable, Identifiable {
    case sessionOrchestration
    case containerSecurity
    case multiRuntime
    case actionControlPlane
    case escalationSystem
    case validationPipeline
    case profileManagement
    case realTimeMonitoring
    case memoryStore
    case seriesWorkflows
    case scheduledJobs
    case issueWatcher
    case analyticsDashboard

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .sessionOrchestration: "Pod Orchestration"
        case .containerSecurity:    "Container Security"
        case .multiRuntime:         "Multi-Runtime Agents"
        case .actionControlPlane:   "Action Control Plane"
        case .escalationSystem:     "Escalation System"
        case .validationPipeline:   "Validation Pipeline"
        case .profileManagement:    "Profile Management"
        case .realTimeMonitoring:   "Real-time Monitoring"
        case .memoryStore:          "Memory Stores"
        case .seriesWorkflows:      "Series Workflows"
        case .scheduledJobs:        "Scheduled Jobs"
        case .issueWatcher:         "Issue Watcher"
        case .analyticsDashboard:   "Analytics Dashboard"
        }
    }

    public var icon: String {
        switch self {
        case .sessionOrchestration: "arrow.triangle.2.circlepath"
        case .containerSecurity:    "lock.shield"
        case .multiRuntime:         "cpu"
        case .actionControlPlane:   "slider.horizontal.3"
        case .escalationSystem:     "bubble.left.and.exclamationmark.bubble.right"
        case .validationPipeline:   "checkmark.shield"
        case .profileManagement:    "folder.badge.gearshape"
        case .realTimeMonitoring:   "waveform.path.ecg"
        case .memoryStore:          "brain"
        case .seriesWorkflows:      "arrow.triangle.branch"
        case .scheduledJobs:        "calendar.badge.clock"
        case .issueWatcher:         "tag.fill"
        case .analyticsDashboard:   "chart.bar.xaxis"
        }
    }

    public var color: Color {
        switch self {
        case .sessionOrchestration: .blue
        case .containerSecurity:    .red
        case .multiRuntime:         .cyan
        case .actionControlPlane:   .purple
        case .escalationSystem:     .orange
        case .validationPipeline:   .green
        case .profileManagement:    .indigo
        case .realTimeMonitoring:   .teal
        case .memoryStore:          .mint
        case .seriesWorkflows:      .purple
        case .scheduledJobs:        .blue
        case .issueWatcher:         .green
        case .analyticsDashboard:   .orange
        }
    }

    public var summary: String {
        switch self {
        case .sessionOrchestration:
            "Full lifecycle management across 15 states — from task queuing through provisioning, agent execution, validation, human review, and merge. Automatic retries, fix pods on CI failure, review_required escalation, and state machine enforcement."
        case .containerSecurity:
            "Every pod runs in an isolated Docker container (or ACI) with per-container iptables firewall rules and an HAProxy SNI proxy for HTTPS egress. Network policies support allow-all, deny-all, restricted, or package-manager shorthand."
        case .multiRuntime:
            "Pluggable runtime architecture supporting Anthropic Claude, OpenAI Codex, and GitHub Copilot. Each runtime streams structured agent events with dedicated parsers."
        case .actionControlPlane:
            "Agents execute approved control-plane actions across 8 groups (GitHub, ADO, Azure Logs, Azure PIM) — with prompt-injection quarantine, PII sanitization, and full audit trail."
        case .escalationSystem:
            "13+ MCP tools injected into agent containers enable structured escalation: ask a human, consult AI, report plans/progress/blockers, self-validate in browser, and manage persistent memories."
        case .validationPipeline:
            "8-phase validation: build → test → health → Playwright smoke → legacy criteria → required facts → AI review → overall. Supports interrupt, per-finding overrides, proof-of-work screenshots, review_required state, and tiered correction feedback."
        case .profileManagement:
            "Profiles define stack templates, credentials, network policies, registries, skills, and MCP servers. Versioned, inheritable, snapshotted at pod creation. Supports local Docker or ACI execution."
        case .realTimeMonitoring:
            "WebSocket event streaming delivers 9 event types to desktop, CLI TUI, and menu bar. 30-day replay, PII-safe broadcast, and monotonic event IDs for gap-free delivery."
        case .memoryStore:
            "Agents suggest persistent knowledge scoped globally, per-profile, or per-pod. Humans approve. Approved memories are injected into future pods' CLAUDE.md automatically."
        case .seriesWorkflows:
            "Multi-pod DAG workflows with dependency chains. Briefs are YAML-frontmatter markdown files — specify depends_on, touches, and ACs. Three PR modes: single (shared branch), stacked (one PR per pod), or none."
        case .scheduledJobs:
            "Cron-triggered pods for recurring tasks — nightly security audits, weekly dependency upgrades, regression sweeps. DB-driven scheduler with catchup recovery and manual trigger support."
        case .issueWatcher:
            "Label a GitHub or ADO issue autopod and the daemon spawns a pod, posts progress comments back to the issue, and updates labels automatically through the pod lifecycle."
        case .analyticsDashboard:
            "Fleet metrics across 6 dimensions: cost by phase/model, first-pass reliability rate, throughput + MTTM, safety events + quarantine scores, quality composite scores, and escalation patterns."
        }
    }

    public var highlights: [String] {
        switch self {
        case .sessionOrchestration: ["15 States", "Fix Pods", "Token Tracking"]
        case .containerSecurity:    ["HAProxy SNI", "iptables", "allow_pkg_mgrs"]
        case .multiRuntime:         ["Claude", "Codex", "Copilot"]
        case .actionControlPlane:   ["8 Groups", "PII Redact", "Audit"]
        case .escalationSystem:     ["13+ Tools", "Memory", "Browser Validate"]
        case .validationPipeline:   ["7 Phases", "Screenshots", "Human Override"]
        case .profileManagement:    ["Versioned", "Snapshotted", "Inheritance"]
        case .realTimeMonitoring:   ["9 Events", "30d Replay", "PII Safe"]
        case .memoryStore:          ["Global", "Profile", "Pod"]
        case .seriesWorkflows:      ["DAG", "3 PR Modes", "Fan-in"]
        case .scheduledJobs:        ["Cron", "Catchup", "Manual Trigger"]
        case .issueWatcher:         ["GitHub", "ADO", "Auto-Label"]
        case .analyticsDashboard:   ["Cost", "Reliability", "Safety"]
        }
    }

    public var subtitle: String {
        switch self {
        case .sessionOrchestration: "15-state machine, fix pods on CI/review failures, review_required, merge_pending, token/cost tracking"
        case .containerSecurity:    "HAProxy SNI proxy + iptables, seccomp, non-root, git isolation, content scanning + local/ACI targets"
        case .multiRuntime:         "Pluggable runtimes with streaming parsers and pod persistence"
        case .actionControlPlane:   "8 groups, 22 actions — gated with injection detection, PII redaction, and PIM support"
        case .escalationSystem:     "13+ MCP tools: human escalation, AI consultation, memory, browser self-validation"
        case .validationPipeline:   "8-phase pipeline: build, test, health, smoke, legacy criteria, facts, AI review, overall + interrupt + overrides + proof-of-work screenshots"
        case .profileManagement:    "Versioned + snapshotted profiles, 11 stacks, 4 providers, local/ACI, inheritance + injection"
        case .realTimeMonitoring:   "9 event types, 30-day replay, PII-safe broadcast"
        case .memoryStore:          "3-scoped persistent knowledge: suggest → approve → inject into CLAUDE.md"
        case .seriesWorkflows:      "YAML-frontmatter briefs, DAG dependency resolution, fan-in, 3 PR modes"
        case .scheduledJobs:        "DB-driven cron scheduler, catchup on restart, manual trigger, enable/disable"
        case .issueWatcher:         "Label-triggered pod spawning for GitHub + ADO, lifecycle comments, PII-safe quarantine"
        case .analyticsDashboard:   "6 fleet dashboards: cost, reliability funnel, throughput, safety, quality, escalations"
        }
    }

    // MARK: - What / Why / How

    public var what: String {
        switch self {
        case .sessionOrchestration:
            "Full lifecycle management across 15 states — from task queuing through provisioning, agent execution, validation, human review, merge_pending, and merge. A strict state machine validates every transition. review_required replaces hard failure when maxValidationAttempts is exhausted, letting humans extend attempts, fix manually, or restart. merge_pending waits for PR merge confirmation. The orchestration loop tracks token usage and cost, monitors commit activity (polled every 60s), captures task summaries and plan deviations, and handles correction feedback loops."
        case .containerSecurity:
            "Pods are locked down at every level. Each pod runs in its own Docker container on an isolated bridge network (autopod-net) with inter-container communication disabled. Per-container iptables OUTPUT chain rules control all egress. Pods run as non-root user autopod:1000 with only NET_ADMIN capability (for iptables). Pods have zero direct git access — all git operations are handled by the manager on the host, with PATs cached in-memory only and never written to any container filesystem."
        case .multiRuntime:
            "A pluggable runtime architecture supporting Anthropic Claude, OpenAI Codex, and GitHub Copilot. Each runtime implements the same interface — spawn, stream AgentEvents, resume, abort — so the orchestration pipeline is provider-agnostic. Claude supports native pod persistence for resume; Codex and Copilot re-spawn with correction messages. All runtimes emit a unified 8-type event union consumed by the event bus."
        case .actionControlPlane:
            "Agents execute approved control-plane operations through a gated, audited pipeline. 8 built-in action groups (GitHub Issues, PRs, Code; ADO Work Items, PRs, Code; Azure Logs; Azure PIM) with 22 actions. Every action request is validated, checked for approval requirements and resource restrictions, then dispatched to the appropriate handler. Every response passes through prompt injection detection (7 threat patterns with compound scoring) and PII sanitization before reaching the agent. Azure PIM actions allow agents to activate, deactivate, and list PIM group assignments — restricted to groups pre-configured on the pod."
        case .escalationSystem:
            "An MCP server injected into every agent container provides 13+ tools for structured agent-human communication. Agents can ask humans (blocking), consult other AIs (rate-limited), report blockers (auto-pauses after threshold), submit plans and progress, report task summaries with deviations, check for operator messages, self-validate in browser, and manage persistent memories. The validate_in_browser tool generates Playwright scripts dynamically, executes them on the host, and captures screenshots as base64 PNGs. Memory tools (memory_suggest, memory_list, memory_read, memory_search) enable agents to build and query accumulated knowledge. Dynamic action tools are registered per profile."
        case .validationPipeline:
            "An 8-phase validation pipeline runs after the agent completes: Build → Test → Health Check → Smoke (Playwright) → Legacy Criteria → Required Facts → AI Task Review → Overall Decision. Each phase gates the next. The AI reviewer receives tiered context: the diff, original task, contract, and findings from all prior attempts. Failed validations trigger automatic retries with structured correction feedback. When maxValidationAttempts is exhausted, the pod moves to review_required instead of failing. Humans can interrupt in-flight validation, queue per-finding overrides that are merged before the next pass, extend attempt counts, or create a linked workspace for manual fixes."
        case .profileManagement:
            "Profiles encode everything needed to run a pod: stack template, execution target (local Docker or ACI), model provider (Anthropic, MAX/PRO, Foundry, Copilot), network policy, output mode, branchPrefix, workerProfile, PIM groups, and all injections. Each update auto-increments a version counter. Pods snapshot the full resolved profile at creation for auditability. Inheritance chains (up to 5 levels) with special merge logic for skills, MCP servers, CLAUDE.md sections, smoke pages, and registries. The system-instructions-generator builds a complete CLAUDE.md with approved memories, priority-sorted sections, dynamic content fetches, and PII sanitization."
        case .realTimeMonitoring:
            "WebSocket event streaming delivers 9 event types to all connected clients: pod.created, status_changed, agent_activity, validation_started, validation_completed, escalation_created, escalation_resolved, pod.completed, and memory.suggestion_created. Events are persisted for 30-day replay, PII-sanitized before broadcast, and delivered with monotonic event IDs for gap detection. Clients subscribe per-pod or globally, with 30-second heartbeat pings and automatic reconnection."
        case .memoryStore:
            "A three-scoped persistent knowledge store for AI pods. Agents call memory_suggest to propose a memory with a scope (global, profile, pod) and content. Humans review and approve or reject via the desktop or API. Approved memories are injected into each new pod's CLAUDE.md at provisioning time. The SHA-256 content hash deduplicates identical suggestions. Memory search supports keyword and semantic queries across the approved store."
        case .seriesWorkflows:
            "Multi-pod DAG workflows defined by brief folders. Each pod has a brief.md for task context and contract.yaml for dependencies, scenarios, required facts, and human review checks. The daemon resolves the dependency graph topologically and spawns pods in order, sharing branch or PR state per the chosen PR mode. Series metadata (purpose.md, design.md) is injected into every pod's AGENTS.md."
        case .scheduledJobs:
            "Cron-scheduled pods stored in the database with cron expressions, profile references, and task descriptions. The daemon evaluates nextRunAt on each scheduler tick and spawns pods when the window elapses. On restart, jobs with missed windows are flagged catchupPending — operators review and decide whether to run or skip each one. Jobs can also be triggered manually regardless of schedule."
        case .issueWatcher:
            "Daemon polls GitHub and ADO issues every 60 seconds on profiles with issueWatcherEnabled. When a trigger label is found, the issue title+body+ACs are sanitized (PII stripped, injection quarantine applied) and a pod is spawned. The trigger label is replaced with autopod:in-progress. Agent escalations are posted as issue comments. On pod completion, the label updates to autopod:done or autopod:failed and a summary comment is posted."
        case .analyticsDashboard:
            "Six fleet analytics dashboards, each queryable over a configurable time window (default 30 days, max 365). Cost tracks spend by phase (agent_initial, agent_rework, review, plan_eval) and by profile+model, with top-10 sessions and waste (killed/failed). Reliability tracks first-pass rate, funnel drop-offs by band, and per-stage failure rates. Throughput tracks pods/day, MTTM, and time-in-status percentiles. Safety tracks PII+injection events, quarantine score histogram, network policy distribution, and audit chain integrity. Quality tracks composite scores (0–100) per pod. Escalations track counts by type and profile."
        }
    }

    public var why: String {
        switch self {
        case .sessionOrchestration:
            "Without a state machine, pods could end up in impossible states — a running pod that's also merging, a killed pod that suddenly completes. review_required gives operators a clear signal: 'this needs your attention' rather than a silent failure. merge_pending prevents race conditions between PR creation and merge. Token/cost tracking makes AI spend visible without external tooling. Task summary captures whether the agent deviated from its declared plan, giving reviewers confidence."
        case .containerSecurity:
            "AI agents running arbitrary code need defense-in-depth, not just trust. A compromised agent shouldn't reach internal services, exfiltrate data, interfere with other pods, or access git credentials. Five layers enforce this: network (iptables egress), capability (minimal caps), user (non-root), git (host-side only, PATs never in container), and content (PII/injection scanning). Shell injection is prevented in iptables rules via SAFE_HOST_REGEX validation on all hostnames."
        case .multiRuntime:
            "Different tasks benefit from different models. Claude excels at complex reasoning, Codex at code generation, Copilot at incremental changes. By abstracting the runtime behind a common interface, teams choose the best model per profile without changing orchestration logic. Pod persistence (Claude) enables efficient resume after escalation or validation failure."
        case .actionControlPlane:
            "Agents need to interact with the real world — trigger deployments, update work items, create PRs — but direct API access is a massive security risk. The ACP provides a controlled gateway where every request is validated, every response is scanned for prompt injection (7 patterns with compound threat scoring) and PII (API keys, AWS keys, emails, etc.), and everything is audit-logged. Quarantined content is wrapped with untrusted markers or blocked entirely above 0.8 threat score."
        case .escalationSystem:
            "Fully autonomous agents hit blockers — ambiguous requirements, missing credentials, architectural decisions needing human judgment. Without structured escalation, agents guess and produce wrong output. The escalation system provides blocking tools (ask_human waits for response), rate-limited AI consultation, auto-pause after repeated blockers, and browser self-validation so agents can verify their own work before human review."
        case .validationPipeline:
            "Trusting AI-generated code without validation is dangerous. The 8-phase pipeline catches issues at every level and keeps required facts executable after merge. Tiered review context (diff + task + contract + prior findings) helps the AI reviewer make better decisions on repeated attempts. review_required prevents pods from silently failing after N attempts — a human decides the path forward. Interrupt lets operators stop a runaway validation. Per-finding overrides prevent real false positives from blocking good work without disabling the entire check."
        case .profileManagement:
            "Every project has different stacks, registries, network rules, credentials, and AI providers. Profiles encode these differences for reproducible pods. Inheritance (up to 5 levels) prevents config duplication — a base profile handles shared settings while child profiles override specifics. Special merge logic ensures skills, MCP servers, and smoke pages accumulate rather than replace, while credentials and network policies take the child's value."
        case .realTimeMonitoring:
            "When an agent is running autonomously, you need to know what it's doing right now — not after it finishes. Real-time streaming lets operators catch problems early, respond to escalations within the agent's timeout window, and maintain confidence in autonomous operations. Event replay with 30-day retention ensures no data loss on reconnection. PII sanitization on events prevents sensitive data from leaking to clients."
        case .memoryStore:
            "AI agents lose all context between pods. Every pod re-reads the same docs, re-learns the same conventions, repeats the same mistakes. Memory stores break this cycle: agents accumulate institutional knowledge, humans curate it, and the system injects it automatically. The suggest-then-approve model ensures no incorrect or sensitive knowledge enters the store without human sign-off."
        case .seriesWorkflows:
            "Large features can't always be done by one agent in one pod. Series lets you decompose work into focused pods with explicit scope guards (touches/does_not_touch), so agents don't collide or duplicate effort. DAG dependencies enforce ordering, fan-in waits for multiple parents, and three PR modes give you flexibility: ship everything on one branch, stack PRs so each merges before the next starts, or just push branches for manual review."
        case .scheduledJobs:
            "Some work is rhythmic: run the security audit every night, check for dependency vulnerabilities every week, sweep for regressions before the Monday sprint. Scheduled jobs encode that rhythm in the daemon itself — no external cron required, no pipelines to maintain. Catchup recovery means a daemon restart doesn't silently swallow a missed run."
        case .issueWatcher:
            "Issue trackers are where work is defined. The issue watcher closes the loop between 'here's what needs doing' and 'here's the code' — no copy-pasting task descriptions, no manual pod creation. Label routing means different teams can trigger different profiles from the same repo. Safety quarantine means adversarial issue content can't manipulate the agent."
        case .analyticsDashboard:
            "Autonomous agents generate invisible operational costs. Without analytics, you don't know which profiles drain the budget, which stages fail most, or whether quality is trending up or down. The six dashboards make fleet health visible: waste shows money spent on pods that never delivered; the reliability funnel shows where pods drop off; the safety dashboard exposes threat patterns before they become incidents."
        }
    }

    public var how: String {
        switch self {
        case .sessionOrchestration:
            "The pod manager's processSession() loop provisions containers, launches the runtime, consumes AgentEvents, monitors escalations, triggers validation, and handles retries. Token usage and cost (inputTokens, outputTokens, costUsd) are captured from AgentCompleteEvents. Commit activity is polled every 60s. report_task_summary captures plan deviations. review_required is entered when the retry counter hits maxValidationAttempts — operators then call extend-attempts, fix-manually, or reject. merge_pending holds the pod until the PR merge webhook confirms completion."
        case .containerSecurity:
            "Containers spawn on an isolated Docker bridge (autopod-net, ICC disabled). The docker-network-manager generates iptables scripts with OUTPUT chain rules: flush → allow loopback → allow established/related → mode-specific rules → final DROP. Git repos are cloned as bare repos with auth URLs, then immediately stripped (git remote set-url origin <cleanUrl>). PATs are cached in-memory only with per-repo mutex locks. Images can be prewarmed (7-day staleness threshold) with credentials stripped post-build."
        case .multiRuntime:
            "Each runtime streams events via its provider's format. Claude uses NDJSON (--output-format stream-json) with pod ID persistence for resume. Codex uses JSONL (--json flag). Copilot streams plain text lines. All parsers emit the same AgentEvent union: status, tool_use, file_change, complete, error, escalation, plan, progress."
        case .actionControlPlane:
            "Agent calls execute_action MCP tool → engine resolves action definition → checks approval gate and resource restrictions → validates params → dispatches to handler → response passes through quarantine() for injection detection (7 patterns, compound scoring: max severity + 0.1 bonus per additional pattern) → then sanitize() for PII (API keys, AWS keys, Azure connections, emails, field-level redaction) → audit logged with piiDetected flag and quarantineScore → response returned to agent."
        case .escalationSystem:
            "The MCP server registers tools at container startup. Blocking tools (ask_human, report_blocker, validate_in_browser) use PendingRequests — a Promise-based map where the agent awaits resolution. The daemon resolves via API when a human responds. For validate_in_browser: an LLM generates a Playwright ESM script → written to /tmp/autopod-browser-check.mjs → executed via node → results parsed from stdout markers → screenshots collected from /tmp/autopod-browser-checks/check-{n}.png as base64."
        case .validationPipeline:
            "Eight sequential phases with gating: (1) Build, (2) Test, (3) Health Check, (4) Smoke, (5) Legacy Criteria, (6) Required Facts from contract.yaml, (7) AI Task Review, (8) Overall. Interrupt aborts via AbortController and returns partial results. Per-finding overrides are flushed from PendingOverrideRepository before each pass. review_required is entered when retries are exhausted."
        case .profileManagement:
            "Profile resolution: inheritance chain walked (max 5 levels), fields merged with special logic for arrays/objects. Skills resolved from GitHub APIs or local files (Promise.allSettled, failures logged and skipped). Registry injection generates .npmrc and NuGet.Config with immediate validation (npm config list / dotnet nuget list source). MCP server URLs rewritten to daemon proxy endpoints. AGENTS.md built from: task → contract → injected sections (priority-sorted, dynamic-fetched) → MCP tools → skills → workflow requirements."
        case .realTimeMonitoring:
            "The event bus persists events to eventRepository, applies processContentDeep() for PII sanitization, then broadcasts to subscribers. WebSocket connections authenticate via token query param, then send subscribe/unsubscribe/replay messages. Events include monotonic _eventId for ordered replay. Heartbeat pings every 30s detect stale connections. Desktop, CLI, and menu bar consume the same protocol — subscribe to pods on selection, receive AgentActivityEvents for live tool use display."
        case .memoryStore:
            "Agent calls memory_suggest MCP tool with scope + content → daemon creates a pending memory record with SHA-256 hash (deduplication). Human approves via PATCH /memory/:id → status transitions to approved. On provisioning, system-instructions-generator queries approved memories for the pod's scope (global, profile-matched, pod-matched) and injects them into CLAUDE.md as a 'Team Knowledge' section. memory_list/read/search tools let the agent query the store at runtime. REST: GET/POST/PATCH/DELETE /memory."
        case .seriesWorkflows:
            "POST /pods/series parses briefs (YAML frontmatter), resolves the dependency DAG topologically, and spawns pods in order. In single mode, non-root pods wait for their parent to complete then commit to the same branch — siblings serialized even when the DAG allows fan-out. In stacked mode, each pod has its own PR and waits for the parent PR to merge before starting. depends_on uses title matching → pod ID; missing titles error at parse time. context_files are resolved relative to the spec root and attached to the pod's CLAUDE.md."
        case .scheduledJobs:
            "Scheduler tick runs every minute; compares nextRunAt (stored per job) to now(). When a job fires, it spawns a pod with the stored profileName + task, then updates nextRunAt to the next cron window. On daemon startup, jobs where nextRunAt is in the past are marked catchupPending=true. The /scheduled-jobs/:id/catchup endpoint triggers the missed run immediately; the DELETE variant skips it. Manual trigger via POST /scheduled-jobs/:id/trigger fires regardless of schedule and does not update nextRunAt."
        case .issueWatcher:
            "Poll loop: every 60s, query each watched profile's issue provider for issues with the trigger label. For each new hit: sanitize title+body+ACs via processContent (quarantine + PII redact), check (provider, issueId, profile) uniqueness, spawn pod, swap label to <prefix>:in-progress, post 'pod started' comment. On pod status change events: update DB status, swap label to <prefix>:done or <prefix>:failed, post outcome comment. ask_human escalations post the question as an issue comment and await reply."
        case .analyticsDashboard:
            "All analytics queries operate on a terminal cohort: non-workspace pods with final status (complete, killed, failed) that completed within the requested window. Cost aggregation groups token usage by phase key (phase_type + attempt_index), joins to model pricing JSON for USD conversion. Reliability funnel counts pods that reached each band, computing drop-off between adjacent bands. Throughput buckets completion timestamps by day. Safety joins safety_events + action_audit tables for dual-source threat counts. Quality reads pre-computed quality_scores table. All endpoints return HTTP 400 for invalid days, HTTP 503 if data is unavailable."
        }
    }

    public var howBullets: [String] {
        switch self {
        case .sessionOrchestration:
            [
                "15 states: queued → provisioning → running → validating → validated → approved → merge_pending → merging → complete (plus awaiting_input, paused, review_required, failed, killing, killed)",
                "Configurable MAX_CONCURRENCY for queue management",
                "Automatic retry on validation failure with correction feedback to agent",
                "review_required: entered when maxValidationAttempts is exhausted — extend-attempts, fix-manually, or reject",
                "merge_pending: waits for PR merge webhook before transitioning to merging",
                "Token + cost tracking: inputTokens, outputTokens, costUsd from AgentCompleteEvent",
                "Commit tracking: commitCount + lastCommitAt polled every 60s",
                "Task summary: report_task_summary MCP tool captures plan deviations",
                "Workspace pods: interactive containers, no agent, workerProfile for handoff",
                "Recovery mode: killed pods can resume validation if worktree preserved",
                "Escalation auto-pause after configurable threshold (default 3)",
            ]
        case .containerSecurity:
            [
                "Execution targets: local (Docker socket) or aci (Azure Container Instances)",
                "Network: autopod-net bridge with ICC disabled, iptables OUTPUT chain per container",
                "allow-all: loopback + established/related, no DROP (trusted environments)",
                "deny-all: DNS only (UDP/TCP 53), everything else DROPped",
                "restricted: HAProxy SNI proxy on loopback port 8443; iptables NAT redirects port 443 to it; HAProxy checks SNI against allowlist, splices TLS bytes through (no MITM)",
                "HAProxy denial events streamed via syslog → socat receiver → safety event aggregator",
                "allow_package_managers: boolean shorthand that adds 15 pkg manager hosts (npm, pypi, crates.io, nuget, golang, rubygems, debian, etc.)",
                "Default allowlist: api.anthropic.com, api.openai.com, registry.npmjs.org, github.com, pkgs.dev.azure.com, etc.",
                "Capability: only NET_ADMIN added (for iptables), no other Docker capabilities",
                "User: non-root autopod:1000, /workspace working dir, restricted mounts",
                "Seccomp: blocks unshare, setns, pivot_root, mount, umount2 and AF_ALG socket (crypto API) via custom seccomp-profile.json",
                "Git: bare repos with PATs stripped, in-memory PAT cache on host, per-repo mutex",
                "Shell injection defense: SAFE_HOST_REGEX validates all hostnames before iptables injection",
                "Image prewarming: 7-day staleness, credentials stripped post-build, ACR push",
            ]
        case .multiRuntime:
            [
                "Claude: NDJSON streaming (stream-json), pod ID persistence, native resume",
                "Codex: JSONL streaming (--json flag), fresh spawn on resume",
                "Copilot: plain text lines, copilot-instructions.md config, re-spawn with correction",
                "8 AgentEvent types: status, tool_use, file_change, complete, error, escalation, plan, progress",
                "Provider credentials: Anthropic (API key), MAX (OAuth + refresh), Foundry (Azure endpoint), Copilot (GitHub token)",
                "Config files auto-generated: .claude.json (onboarding skip), .credentials.json (OAuth)",
            ]
        case .actionControlPlane:
            [
                "8 built-in action groups: github-issues, github-prs, github-code, ado-workitems, ado-prs, ado-code, azure-logs, azure-pim",
                "22 actions total across all groups",
                "azure-pim: activate_pim_group, deactivate_pim_group, list_pim_activations — restricted to pod-configured groups",
                "4 handlers: Azure (ARM), ADO (REST), GitHub (API), generic HTTP (templates)",
                "Approval gates: per-action requiresApproval flag blocks execution, routes to ask_human",
                "Resource restrictions: allowedResources limits which repos/resources actions can target",
                "Prompt injection: 7 patterns (direct-instruction, role-manipulation, token-boundary, exfiltration, tool-abuse, encoding-trick, xml-tag-injection)",
                "Threat scoring: max severity + compound bonus (up to +0.2), three tiers: pass (<0.5) / quarantine-wrap (0.5-0.8) / block (>0.8)",
                "PII redaction: API keys, AWS keys, Azure connections, emails, plus field-level (password, secret, token, api_key, private_key)",
                "Audit: podId, actionName, sanitized params, response summary, piiDetected, quarantineScore, timestamp",
            ]
        case .escalationSystem:
            [
                "ask_human — Blocking: pauses agent, waits for human response or timeout",
                "ask_ai — Rate-limited: calls reviewer model, max N calls per pod",
                "report_blocker — Conditionally blocking: auto-pauses after threshold escalations",
                "report_plan — Fire-and-forget: submits plan summary + steps",
                "report_progress — Fire-and-forget: reports phase transitions (currentPhase/totalPhases)",
                "report_task_summary — Fire-and-forget: captures actual work vs plan deviations",
                "check_messages — Non-blocking: polls for pending nudge/tell messages without pausing",
                "validate_in_browser — Blocking: LLM generates Playwright script → executes on host → captures screenshots as base64",
                "trigger_revalidation — Workspace pods only: re-runs validation on linked failed worker",
                "memory_suggest — Proposes a memory for human approval (global/profile/pod scope)",
                "memory_list — Lists approved memories available to this pod",
                "memory_read — Retrieves full content of a specific memory",
                "memory_search — Keyword/semantic search across available memories",
                "Dynamic action tools — One MCP tool per ActionDefinition from profile's action policy",
            ]
        case .validationPipeline:
            [
                "Phase 1 — Build: runs profile.buildCommand (default timeout 300s), gates all downstream",
                "Phase 2 — Test: runs profile.testCommand (default timeout 600s), requires build pass",
                "Phase 3 — Health Check: polls healthCheckUrl for HTTP 200, configurable timeout",
                "Phase 4 — Smoke: Playwright scripts from smokePages, runs on daemon host, captures screenshots + console errors",
                "Phase 5 — Legacy Criteria: existing criteria still run for older pods",
                "Phase 6 — Required Facts: contract.yaml commands verify durable proof artifacts",
                "Phase 7 — AI Task Review: reviewer model checks diff + original task + prior findings (tiered context)",
                "Phase 8 — Overall: pass only if all required phases pass, strictly binary",
                "Proof-of-work screenshots: every validation pass captures PNGs per smoke page, legacy criterion, and AI review, accessible via GET /pods/:id/screenshots",
                "Agent self-validation: validate_in_browser MCP tool during development",
                "Retry loop: correction feedback + diff injected into agent, up to maxValidationAttempts (default 3)",
                "review_required: entered when retries exhausted — extend-attempts, fix-manually, or reject",
                "Interrupt: POST /pods/:id/interrupt-validation aborts via AbortController, returns partial result",
                "Per-finding overrides: PendingOverrideRepository queues dismiss/guidance, flushed before each pass",
                "Human review: HTML report with Tailwind, embedded screenshots, container preserved for preview",
            ]
        case .profileManagement:
            [
                "11 stack templates: node22, node22-pw, dotnet9, dotnet10, dotnet10-go, python312, python-node, python-node-pg, go124, go124-pw, custom",
                "3 output modes: pr (full pipeline), artifact (research-output.md), workspace (interactive)",
                "4 model providers: Anthropic (API key), MAX/PRO (OAuth + token refresh), Foundry (Azure endpoint), Copilot (GitHub token)",
                "Execution targets: local (Docker socket) or aci (Azure Container Instances)",
                "profile.version: auto-incrementing integer on every profile update",
                "Profile snapshot: full resolved profile (incl. inherited values) stored with pod at creation",
                "branchPrefix: custom prefix for auto-generated pod branch names",
                "workerProfile: names the profile to use when handing off from a workspace pod to a worker",
                "pimGroups: pre-configure PIM groups for automatic activation on workspace pods",
                "Inheritance: up to 5 levels, fields that never inherit: name, extends, timestamps",
                "Special merge: skills/MCP servers merge by name (child wins), smokePages append, memories inject",
                "Skill resolution: GitHub API fetch (15s timeout) or local file read, failures logged + skipped",
                "Registry injection: .npmrc / NuGet.Config generated, immediately validated",
                "AGENTS.md: memories → task → contract → sections (priority-sorted) → MCP tools → skills",
                "Credentials: AES-256-GCM at rest, key at ~/.autopod/secrets.key (0600 perms)",
            ]
        case .realTimeMonitoring:
            [
                "9 SystemEvent types: pod.created, status_changed, agent_activity, validation_started, validation_completed, escalation_created, escalation_resolved, pod.completed, memory.suggestion_created",
                "Event persistence: 30-day retention, monotonic event IDs, gap-free replay",
                "PII sanitization: processContentDeep() strips sensitive data before broadcast",
                "WebSocket protocol: subscribe/unsubscribe per-pod, subscribe_all, replay from lastEventId",
                "Heartbeat: 30-second ping/pong cycle, stale connection cleanup",
                "Desktop app: live pod monitoring with event stream + terminal access + preview screenshots",
                "CLI TUI: Ink/React dashboard with keyboard shortcuts",
                "Menu bar: attention count badge, quick pod access",
            ]
        case .memoryStore:
            [
                "3 scopes: global (all pods), profile (same profile), pod (current pod only)",
                "memory_suggest MCP tool: agent proposes content + scope → pending state",
                "SHA-256 content hash: deduplicates identical suggestions",
                "Human approval via PATCH /memory/:id → approved; rejected memories are discarded",
                "Injection: system-instructions-generator queries approved memories and injects into CLAUDE.md 'Team Knowledge' section",
                "memory_list — paginated list of approved memories for this pod's scope chain",
                "memory_read — full content of a single memory entry",
                "memory_search — keyword/semantic search across available memories",
                "REST API: GET /memory, POST /memory, PATCH /memory/:id (approve/reject), DELETE /memory/:id",
                "Desktop: MemoryManagementView for browsing + approving, suggestion cards in OverviewTab",
                "SystemEvent: memory.suggestion_created delivered to all connected clients",
            ]
        case .seriesWorkflows:
            [
                "Brief format: YAML frontmatter (title, task, depends_on, touches, does_not_touch, acceptance_criteria, context_files) in any .md file under briefs/",
                "Spec folder: briefs/ required, purpose.md + design.md optional — injected into every pod's CLAUDE.md",
                "DAG resolution: topological sort via Kahn's algorithm, fan-in via depends_on title references",
                "PR mode single: all pods share one branch, siblings serialized; only final pod creates PR",
                "PR mode stacked: each pod gets its own PR; non-root pods wait for parent PR to merge",
                "PR mode none: pods push branches only, no PRs created",
                "autoApprove: skip human gate between pods; disableAskHuman: route escalations to AI reviewer",
                "Series preview: POST /pods/series/preview reads spec from daemon host; /preview-branch reads from git branch",
                "Cost rollup: GET /pods/series/:id returns sum of all pod token usage and cost",
                "DELETE /pods/series/:id kills all pods and cascade-deletes series metadata",
            ]
        case .scheduledJobs:
            [
                "Cron expression format: 5-field standard (minute hour day month weekday)",
                "nextRunAt: computed from cron + current time on create/update, updated after each fire",
                "Scheduler tick: evaluates all enabled jobs; spawns pod when nextRunAt ≤ now()",
                "Spawned pod uses stored profileName + task — no runtime overrides",
                "catchupPending: set on daemon startup for jobs where nextRunAt is in the past",
                "POST /scheduled-jobs/:id/catchup — run missed job now (sets lastRunAt, updates nextRunAt)",
                "DELETE /scheduled-jobs/:id/catchup — skip missed run (clears catchupPending, updates nextRunAt)",
                "POST /scheduled-jobs/:id/trigger — fire immediately, does not affect nextRunAt",
                "lastPodId: tracks the pod spawned by the most recent run for status inspection",
                "Jobs can be disabled (enabled: false) without deletion; reenable via PUT or ap schedule enable",
            ]
        case .issueWatcher:
            [
                "Profiles opt in via issueWatcherEnabled: true; label prefix defaults to 'autopod'",
                "Poll interval: 60s; iterates all enabled profiles, queries each issue provider",
                "Label routing: bare label → this profile; 'autopod:name' → route to profile 'name' (same repo only)",
                "Label suffix 'artifact' → force outputMode: artifact on spawned pod",
                "Safety quarantine: title+body+ACs passed through processContent (PII redact + injection check) before storage",
                "Duplicate guard: (provider, issueId, profile) uniqueness check before spawning",
                "Pod spawn: task = sanitized issue title + body; ACs extracted from issue body markers",
                "Label swap: trigger label removed, '<prefix>:in-progress' label added",
                "Comment on start: 'autopod pod <id> started for this issue'",
                "ask_human escalation: question posted as issue comment, awaits reply",
                "Completion: label updated to '<prefix>:done' or '<prefix>:failed', summary comment posted",
                "API: GET /issue-watcher (with ?profile=&status= filters), GET /issue-watcher/:id",
            ]
        case .analyticsDashboard:
            [
                "All endpoints: GET /pods/analytics/{cost|reliability|throughput|safety|quality|escalations}?days=N",
                "Terminal cohort: non-workspace pods, final status (complete|killed|failed), completed in window",
                "Cost: total USD, daily sparkline, deltaVsPrior, byPhase (agent_initial/rework/review/plan_eval), byProfileModel, top10, waste",
                "Reliability: firstPassRate (0 rework), sparkline, funnel bands + drops with topPods, stageFailures table, profileHeatmap",
                "Throughput: podsPerDay sparkline, MTTM (mean time to merge), queue depth by hour (max + mean), time-in-status percentiles (p25/p50/p75/p90/max)",
                "Safety: PII + injection event counts by kind/pattern/source, quarantine histogram (10 buckets 0.0–1.0), network policy distribution, audit chain integrity",
                "Quality: composite score 0–100 per pod (read:edit ratio, blind edits, stop phrases, validation pass, churn, fix attempts)",
                "Escalations: total by type, by profile, daily sparkline",
                "Error handling: HTTP 400 for invalid days param, HTTP 503 if data unavailable",
                "Desktop: Analytics tab with sparklines, funnel diagrams, heatmaps, and drill-down views",
            ]
        }
    }

    public var keyFiles: [String] {
        switch self {
        case .sessionOrchestration:
            ["pod-manager.ts", "state-machine.ts", "pod-repository.ts", "event-bus.ts", "pr-fix-task.ts"]
        case .containerSecurity:
            ["docker-network-manager.ts", "haproxy-config.ts", "haproxy-deny-stream.ts", "docker-container-manager.ts", "seccomp-profile.json"]
        case .multiRuntime:
            ["claude-runtime.ts", "codex-runtime.ts", "copilot-runtime.ts", "claude-stream-parser.ts", "env-builder.ts"]
        case .actionControlPlane:
            ["action-engine.ts", "action-registry.ts", "action-audit-repository.ts", "azure-pim-handler.ts", "processor.ts", "quarantine.ts"]
        case .escalationSystem:
            ["server.ts", "pod-bridge.ts", "pending-requests.ts", "validate-in-browser.ts", "ask-human.ts", "memory-suggest.ts"]
        case .validationPipeline:
            ["local-validation-engine.ts", "playwright-script.ts", "parse-results.ts", "screenshot-store.ts", "pending-override-repository.ts"]
        case .profileManagement:
            ["profile-store.ts", "inheritance.ts", "skill-resolver.ts", "system-instructions-generator.ts", "registry-injector.ts", "credentials-cipher.ts"]
        case .realTimeMonitoring:
            ["event-bus.ts", "websocket.ts", "EventStream.swift", "useWebSocket.ts"]
        case .memoryStore:
            ["memory-repository.ts", "server.ts (memory MCP tools)", "system-instructions-generator.ts", "MemoryManagementView.swift", "MemoryStore.swift"]
        case .seriesWorkflows:
            ["series.ts (route)", "series.ts (CLI command)", "pod-manager.ts"]
        case .scheduledJobs:
            ["scheduled-jobs.ts (route)", "schedule.ts (CLI command)"]
        case .issueWatcher:
            ["issue-watcher.ts (route)"]
        case .analyticsDashboard:
            ["cost-aggregation.ts", "reliability-aggregator.ts", "throughput-aggregator.ts", "safety-aggregator.ts", "quality-score.ts", "escalations-aggregator.ts"]
        }
    }

    public var relatedFeatures: [FeatureCategory] {
        switch self {
        case .sessionOrchestration: [.containerSecurity, .validationPipeline, .escalationSystem]
        case .containerSecurity:    [.actionControlPlane, .profileManagement]
        case .multiRuntime:         [.sessionOrchestration, .escalationSystem]
        case .actionControlPlane:   [.escalationSystem, .containerSecurity]
        case .escalationSystem:     [.memoryStore, .actionControlPlane, .validationPipeline]
        case .validationPipeline:   [.escalationSystem, .sessionOrchestration]
        case .profileManagement:    [.containerSecurity, .multiRuntime, .memoryStore]
        case .realTimeMonitoring:   [.sessionOrchestration, .escalationSystem]
        case .memoryStore:          [.escalationSystem, .profileManagement]
        case .seriesWorkflows:      [.sessionOrchestration, .profileManagement]
        case .scheduledJobs:        [.sessionOrchestration, .profileManagement]
        case .issueWatcher:         [.sessionOrchestration, .actionControlPlane]
        case .analyticsDashboard:   [.validationPipeline, .sessionOrchestration, .containerSecurity]
        }
    }
}

// MARK: - Preview

#Preview("Feature Overview") {
    @Previewable @State var selected: FeatureCategory? = nil
    FeatureOverviewView(selectedFeature: $selected)
        .frame(width: 900, height: 800)
}
