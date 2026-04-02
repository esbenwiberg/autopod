import SwiftUI

public struct StatusDot: View {
    public let status: SessionStatus
    public init(status: SessionStatus) { self.status = status }

    @State private var pulse = false
    @State private var rotation = 0.0

    public var body: some View {
        ZStack {
            switch status {
            case .queued:
                Circle()
                    .stroke(status.color.opacity(0.5), lineWidth: 1.5)
                    .frame(width: 10, height: 10)

            case .provisioning, .killing:
                Circle()
                    .fill(status.color)
                    .frame(width: 10, height: 10)
                    .scaleEffect(pulse ? 1.15 : 1.0)
                    .opacity(pulse ? 0.7 : 1.0)
                    .onAppear {
                        withAnimation(.easeInOut(duration: 0.8).repeatForever(autoreverses: true)) {
                            pulse = true
                        }
                    }

            case .validating, .merging:
                Circle()
                    .trim(from: 0.15, to: 1.0)
                    .stroke(status.color, style: StrokeStyle(lineWidth: 2, lineCap: .round))
                    .frame(width: 10, height: 10)
                    .rotationEffect(.degrees(rotation))
                    .onAppear {
                        withAnimation(.linear(duration: 0.9).repeatForever(autoreverses: false)) {
                            rotation = 360
                        }
                    }

            case .validated, .approved:
                Image(systemName: "checkmark.circle.fill")
                    .foregroundStyle(status.color)
                    .font(.system(size: 11))

            case .complete:
                Image(systemName: "checkmark.circle.fill")
                    .foregroundStyle(.secondary)
                    .font(.system(size: 11))

            case .failed, .killed:
                Image(systemName: "xmark.circle.fill")
                    .foregroundStyle(status.color)
                    .font(.system(size: 11))

            case .awaitingInput:
                Circle()
                    .fill(status.color)
                    .frame(width: 10, height: 10)
                    .shadow(color: status.color.opacity(0.6), radius: pulse ? 4 : 2)
                    .onAppear {
                        withAnimation(.easeInOut(duration: 1.2).repeatForever(autoreverses: true)) {
                            pulse = true
                        }
                    }

            default:
                Circle()
                    .fill(status.color)
                    .frame(width: 10, height: 10)
            }
        }
        .frame(width: 14, height: 14)
    }
}

#Preview("All status dots") {
    HStack(spacing: 16) {
        ForEach([
            SessionStatus.queued,
            .provisioning,
            .running,
            .awaitingInput,
            .validating,
            .validated,
            .failed,
            .merging,
            .complete,
            .killed,
        ], id: \.rawValue) { status in
            VStack(spacing: 6) {
                StatusDot(status: status)
                Text(status.label)
                    .font(.system(size: 9))
                    .foregroundStyle(.secondary)
            }
        }
    }
    .padding(20)
}
