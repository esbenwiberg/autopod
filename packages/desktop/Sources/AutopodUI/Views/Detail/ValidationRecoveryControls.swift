import AutopodClient
import Observation
import SwiftUI

@MainActor @Observable
public final class ValidationRecoveryController {
  public private(set) var state: ValidationRecoveryState?
  public private(set) var isSubmitting = false
  public private(set) var loadError: String?
  public private(set) var requestError: String?
  public private(set) var message: String?
  private let podId: String
  private let actions: PodActions
  private var revision = 0

  public init(podId: String, actions: PodActions) {
    self.podId = podId
    self.actions = actions
  }

  public var isPending: Bool { isSubmitting || state?.activeAction != nil }

  public var reconciliationCommand: String? {
    guard state?.fixValidation.code == "VALIDATION_EXECUTION_UNVERIFIED"
      || state?.retryChecks.code == "VALIDATION_EXECUTION_UNVERIFIED" else { return nil }
    return "ap reconcile-validation \(podId) --json"
  }

  public func canRequest(_ action: String) -> Bool {
    guard !isPending, loadError == nil, let state, state.validationTimestamp != nil else { return false }
    return action == "fix-validation" ? state.fixValidation.allowed
      : action == "retry-checks" && state.retryChecks.allowed
  }

  public func refresh() async {
    revision += 1
    let expected = revision
    do {
      let next = try await actions.loadValidationRecovery(podId)
      guard revision == expected, !Task.isCancelled else { return }
      state = next
      loadError = nil
    } catch {
      guard revision == expected, !Task.isCancelled else { return }
      loadError = "Cannot verify recovery eligibility: \(error.localizedDescription)"
    }
  }

  public func request(_ action: String) async {
    guard canRequest(action), let state else { return }
    isSubmitting = true
    revision += 1 // Discard an older poll that was started before this request.
    requestError = nil
    message = nil
    defer { isSubmitting = false }
    do {
      let input = try ValidationRecoveryRequest(action: action, state: state)
      try await actions.requestValidationRecovery(podId, input)
      message = action == "fix-validation"
        ? "Repair requested. Waiting for daemon admission and worker progress."
        : "Check retry requested. No coding worker, publication or merge was requested."
    } catch {
      // A lost response is not a reason to repeat the POST. Observe the daemon first.
      requestError = error.localizedDescription
    }
    await refresh()
  }
}

struct ValidationRecoveryControls: View {
  let podId: String
  let status: String
  let actions: PodActions
  @State private var controller: ValidationRecoveryController

  init(podId: String, status: String, actions: PodActions) {
    self.podId = podId
    self.status = status
    self.actions = actions
    _controller = State(initialValue: ValidationRecoveryController(podId: podId, actions: actions))
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack(spacing: 10) {
        Button {
          Task { await controller.request("fix-validation") }
        } label: {
          Label(controller.state?.activeAction == "fix-validation" ? "Fix requested…" : "Fix validation",
                systemImage: "wand.and.stars")
        }
        .buttonStyle(.borderedProminent)
        .disabled(!controller.canRequest("fix-validation"))
        .help(controller.state?.fixValidation.reason ?? "Ask the worker to repair failed checks, then follow normal validation and delivery policy. Existing retry permissions and budgets apply.")
        .accessibilityIdentifier("validation.fix")

        Button {
          Task { await controller.request("retry-checks") }
        } label: {
          Label(controller.state?.activeAction == "retry-checks" ? "Retry requested…" : "Retry checks",
                systemImage: "arrow.clockwise")
        }
        .buttonStyle(.bordered)
        .disabled(!controller.canRequest("retry-checks"))
        .help(controller.state?.retryChecks.reason ?? "Run checks again without starting a coding worker or requesting delivery.")
        .accessibilityIdentifier("validation.retryChecks")

        if controller.isPending { ProgressView().controlSize(.small) }
        Button("Refresh") { Task { await controller.refresh() } }
          .buttonStyle(.plain).disabled(controller.isSubmitting)
      }
      .controlSize(.small)

      Text("Fix asks a worker to repair failures. Retry runs checks without a coding worker. Neither bypasses validation or retry limits. Attempt counts are per cycle; retry permissions remain task-wide.")
        .font(.caption).foregroundStyle(.secondary)
      if let message = controller.message { Text(message).font(.caption).foregroundStyle(.secondary) }
      if let error = controller.requestError ?? controller.loadError ?? controller.state?.lastError?.message {
        Text(error).font(.caption).foregroundStyle(.red).textSelection(.enabled)
      }
      if !controller.isPending, let state = controller.state {
        if let reason = state.fixValidation.reason {
          Text("Fix validation: \(reason)").font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
        }
        if let reason = state.retryChecks.reason, reason != state.fixValidation.reason {
          Text("Retry checks: \(reason)").font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
        }
        if let command = controller.reconciliationCommand {
          Text("Termination proof is required before repair or checks. Inspect the exact validation evidence with the command below, and retain the original resource and reports. Inspection does not delete anything. Missing legacy ownership remains blocked.")
            .font(.caption).foregroundStyle(.secondary)
          Text(command)
            .font(.caption.monospaced()).textSelection(.enabled)
          Text("Destructive recovery is unavailable: the current provider cannot prove final source/report preservation while an execution remains unknown. No resume or deletion is performed. Budget selection and retry permission are separate; neither settles the execution.")
            .font(.caption).foregroundStyle(.secondary)
        }
        if state.fixValidation.code?.hasPrefix("TASK_RETRY") == true
          || state.retryChecks.code?.hasPrefix("TASK_RETRY") == true
          || state.lastError?.code == "RECOVERY_NOT_STARTED" {
          DisclosureGroup("Review retry authorization") {
            TaskRetryCard(podId: podId, status: status, actions: actions, stage: "worker")
            TaskRetryCard(podId: podId, status: status, actions: actions)
          }
        }
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .task(id: "\(podId).\(status)") {
      while !Task.isCancelled {
        await controller.refresh()
        do { try await Task.sleep(for: .seconds(controller.isPending ? 2 : 10)) }
        catch { return }
      }
    }
  }
}
