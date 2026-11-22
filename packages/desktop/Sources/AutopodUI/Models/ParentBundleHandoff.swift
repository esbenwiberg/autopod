import AutopodClient
import Foundation
import Observation

public struct ParentBundleSendGuard: Sendable {
  let check: @MainActor @Sendable () throws -> Void
  @MainActor public func callAsFunction() throws { try check() }
}

/// Desktop binds these calls to one ActionHandler's connection lease.
public struct ParentBundleActions: Sendable {
  let isCurrent: @MainActor @Sendable () -> Bool
  let preview: @MainActor @Sendable (ParentBundleSelection, ParentBundleSendGuard) async throws -> ParentBundleReview
  let approve: @MainActor @Sendable (ParentBundleSelection, ParentBundleReview, ParentBundleSendGuard) async throws -> ParentBundleApproval
  let download: @MainActor @Sendable (ParentBundleSelection, ParentBundleApproval, ParentBundleSendGuard) async throws -> Data

  public init(
    isCurrent: @escaping @MainActor @Sendable () -> Bool,
    preview: @escaping @MainActor @Sendable (ParentBundleSelection, ParentBundleSendGuard) async throws -> ParentBundleReview,
    approve: @escaping @MainActor @Sendable (ParentBundleSelection, ParentBundleReview, ParentBundleSendGuard) async throws -> ParentBundleApproval,
    download: @escaping @MainActor @Sendable (ParentBundleSelection, ParentBundleApproval, ParentBundleSendGuard) async throws -> Data
  ) {
    self.isCurrent = isCurrent
    self.preview = preview
    self.approve = approve
    self.download = download
  }
}

struct ParentBundleTarget: Hashable, Identifiable, Sendable {
  let scope: ParentFamilyScope
  let selection: ParentBundleSelection
  var id: Self { self }
}

@MainActor @Observable
final class ParentBundleHandoff {
  enum Work: Equatable { case preview, approve, save }

  private(set) var review: ParentBundleReview?
  private(set) var approval: ParentBundleApproval?
  private(set) var work: Work?
  private(set) var notice: String?
  private var generation = UUID()
  private var active = true

  func close() {
    active = false
    generation = UUID()
    review = nil
    approval = nil
    work = nil
    notice = nil
  }

  private func guardWork(
    _ work: Work,
    actions: ParentBundleActions,
    isCurrent: @escaping @MainActor @Sendable () -> Bool
  ) -> ParentBundleSendGuard? {
    guard active, self.work == nil, actions.isCurrent(), isCurrent(), !Task.isCancelled else { return nil }
    let generation = UUID()
    self.generation = generation
    self.work = work
    notice = nil
    return ParentBundleSendGuard { [weak self] in
      try Task.checkCancellation()
      guard let self, self.active, self.generation == generation, actions.isCurrent(), isCurrent() else {
        throw CancellationError()
      }
    }
  }

  func load(
    _ selection: ParentBundleSelection, actions: ParentBundleActions,
    isCurrent: @escaping @MainActor @Sendable () -> Bool
  ) async {
    guard review == nil, let check = guardWork(.preview, actions: actions, isCurrent: isCurrent) else { return }
    defer { work = nil }
    do {
      let value = try await actions.preview(selection, check)
      try check()
      guard value.matches(selection) else { throw URLError(.badServerResponse) }
      review = value
    } catch {
      if (try? check()) != nil { notice = "Couldn’t load the exact tested change. Refresh and try again." }
    }
  }

  func approve(
    _ selection: ParentBundleSelection, actions: ParentBundleActions,
    isCurrent: @escaping @MainActor @Sendable () -> Bool
  ) async {
    guard let review, review.matches(selection), approval == nil,
      let check = guardWork(.approve, actions: actions, isCurrent: isCurrent) else { return }
    defer { work = nil }
    do {
      let value = try await actions.approve(selection, review, check)
      try check()
      guard value.matches(review) else { throw URLError(.badServerResponse) }
      approval = value
    } catch {
      if (try? check()) != nil {
        notice = "Approval wasn’t confirmed. No download started. Reopen the review before trying again."
        self.review = nil
      }
    }
  }

  func save(
    _ selection: ParentBundleSelection, actions: ParentBundleActions,
    isCurrent: @escaping @MainActor @Sendable () -> Bool,
    chooseDestination: @MainActor (String) async -> URL?
  ) async {
    guard let approval, approval.review.matches(selection),
      let check = guardWork(.save, actions: actions, isCurrent: isCurrent) else { return }
    defer { work = nil }
    do {
      let bytes = try await actions.download(selection, approval, check)
      try check()
      guard let destination = await chooseDestination("parent-\(selection.commit).bundle") else { return }
      try check()
      try bytes.write(to: destination, options: .atomic)
      notice = "Verified bundle saved. Nothing was published."
    } catch {
      if (try? check()) != nil { notice = "Couldn’t verify or save the bundle. No bundle was saved by this attempt." }
    }
  }
}
