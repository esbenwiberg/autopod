import AutopodClient
import SwiftUI

struct ValidationPhaseClock {
  let timing: ValidationPhaseTiming?
  let now: Date

  var elapsed: TimeInterval? { timing.map { max(0, now.timeIntervalSince($0.startedAt)) } }
  var expected: TimeInterval? {
    guard let estimate = timing?.estimate, estimate.durationMs > 0, estimate.sampleCount > 0 else { return nil }
    return Double(estimate.durationMs) / 1_000
  }

  var fraction: Double? {
    guard let elapsed, let expected, elapsed < expected else { return nil }
    return elapsed / expected
  }

  var overEstimate: Bool {
    guard let elapsed, let expected else { return false }
    return elapsed >= expected
  }

  var label: String {
    guard let elapsed else { return "Running" }
    if let expected, elapsed < expected {
      let remaining = expected - elapsed
      let rounded = remaining >= 60 ? "\(Int(ceil(remaining / 60)))m" : "\(Int(ceil(remaining)))s"
      return "~\(rounded) left"
    }
    return "\(Self.duration(elapsed)) elapsed"
  }

  var detail: String {
    guard let elapsed else { return label }
    let elapsedLabel = "\(Self.duration(elapsed)) elapsed"
    guard let expected else { return elapsedLabel }
    let source = timing?.estimate?.sampleCount == 1 ? "last run" : "typical"
    let baseline = "\(source): \(Self.duration(expected))"
    return overEstimate ? "\(elapsedLabel) · over estimate (\(baseline))" : "\(elapsedLabel) · \(label) (\(baseline))"
  }

  private static func duration(_ value: TimeInterval) -> String {
    let seconds = Int(value)
    let minutes = seconds / 60
    if minutes == 0 { return "\(seconds)s" }
    let rest = seconds % 60
    return rest == 0 ? "\(minutes)m" : "\(minutes)m \(rest)s"
  }
}

struct DesktopValidationPhaseCard: View {
  let phase: ValidationPhase
  let state: ValidationPhaseState
  let isSelected: Bool
  let subLabel: String?
  let timing: ValidationPhaseTiming?
  let action: () -> Void
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  private var icon: String {
    switch phase {
    case .setup: "shippingbox"
    case .lint: "text.badge.checkmark"
    case .sast: "shield.lefthalf.filled"
    case .build: "hammer"
    case .test: "testtube.2"
    case .health: "heart.text.square"
    case .pages: "globe"
    case .facts: "checkmark.seal"
    case .review: "checkmark.bubble"
    case .advisory: "sparkles"
    }
  }
  private var status: String {
    switch state.status {
    case .notStarted: "Not started"
    case .running: "Running"
    case .passed: "Passed"
    case .failed: "Failed"
    case .skipped: "Skipped"
    case .pendingHuman: "Needs review"
    }
  }
  var body: some View {
    if state.status == .running {
      TimelineView(.periodic(from: .now, by: 1)) { context in
        card(clock: ValidationPhaseClock(timing: timing, now: context.date))
      }
    } else {
      card(clock: nil)
    }
  }

  private func card(clock: ValidationPhaseClock?) -> some View {
    let label = subLabel ?? clock?.label ?? status
    return Button(action: action) {
      VStack(alignment: .leading, spacing: 10) {
        HStack {
          Image(systemName: icon).font(.system(size: 17, weight: .medium))
            .foregroundStyle(isSelected ? DesktopTheme.accent : .secondary)
          Spacer(minLength: 8)
          if state.status == .running && !reduceMotion {
            ProgressView().controlSize(.mini)
          } else {
            Image(systemName: state.status.icon).font(.caption2).foregroundStyle(state.status.color)
          }
        }
        Text(phase.displayName).font(.callout.weight(.semibold))
        Text(label).font(.caption2).monospacedDigit().foregroundStyle(state.status.color)
          .lineLimit(1)
      }
      .padding(12).frame(width: 108, height: 94, alignment: .topLeading)
      .background(isSelected ? DesktopTheme.selection : DesktopTheme.canvas, in: RoundedRectangle(cornerRadius: 8))
      .overlay(RoundedRectangle(cornerRadius: 8).stroke(isSelected ? DesktopTheme.accent : DesktopTheme.line))
      .overlay(alignment: .bottom) {
        if let clock {
          progressTrack(fraction: clock.fraction)
            .frame(height: 3)
            .padding(.horizontal, 12)
            .padding(.bottom, 8)
            .allowsHitTesting(false)
            .accessibilityHidden(true)
        }
      }
      .contentShape(RoundedRectangle(cornerRadius: 8))
    }
    .buttonStyle(.plain)
    .help([phase.displayName, status, subLabel, clock?.detail].compactMap { $0 }.joined(separator: " · "))
    .accessibilityLabel("\(phase.displayName), \(status)")
    .accessibilityValue(clock?.detail ?? subLabel ?? "")
    .accessibilityIdentifier("validation-phase-\(phase.rawValue)")
    .accessibilityAddTraits(isSelected ? .isSelected : [])
  }

  private func progressTrack(fraction: Double?) -> some View {
    GeometryReader { geometry in
      let width = geometry.size.width
      ZStack(alignment: .leading) {
        Capsule().fill(DesktopTheme.accent.opacity(0.18))
        if let fraction {
          Capsule().fill(DesktopTheme.accent).frame(width: width * fraction)
        } else if reduceMotion {
          movingSegment(width: width, position: 0.5)
        } else {
          TimelineView(.animation(minimumInterval: 1.0 / 24)) { context in
            let cycle = context.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 2.4) / 2.4
            movingSegment(width: width, position: 1 - abs(2 * cycle - 1))
          }
        }
      }
    }
  }

  private func movingSegment(width: CGFloat, position: Double) -> some View {
    Capsule().fill(DesktopTheme.accent).frame(width: width * 0.28)
      .offset(x: width * 0.72 * position)
  }
}
