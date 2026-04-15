import AutopodClient
import SwiftUI

/// Modal sheet for creating a new scheduled job.
public struct CreateScheduledJobSheet: View {
  @Binding public var isPresented: Bool
  public var profileNames: [String]
  public var onCreateJob: ((CreateScheduledJobRequest) -> Void)?

  public init(
    isPresented: Binding<Bool>,
    profileNames: [String] = ["my-app"],
    onCreateJob: ((CreateScheduledJobRequest) -> Void)? = nil
  ) {
    self._isPresented = isPresented
    self.profileNames = profileNames
    self.onCreateJob = onCreateJob
  }

  private var profiles: [String] { profileNames.isEmpty ? ["my-app"] : profileNames }

  @State private var selectedProfile = ""
  @State private var name = ""
  @State private var cronExpression = ""
  @State private var task = ""
  @State private var enabled = true

  private var canCreate: Bool {
    !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
      && isValidCron(cronExpression)
      && !task.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
  }

  public var body: some View {
    VStack(spacing: 0) {
      // Header
      HStack {
        Text("New Scheduled Job")
          .font(.headline)
        Spacer()
        Button {
          isPresented = false
        } label: {
          Image(systemName: "xmark.circle.fill")
            .foregroundStyle(.tertiary)
            .font(.title3)
        }
        .buttonStyle(.borderless)
      }
      .padding(.horizontal, 20)
      .padding(.top, 20)
      .padding(.bottom, 12)

      Divider()

      // Form
      ScrollView {
        VStack(alignment: .leading, spacing: 18) {
          // Profile
          formSection("Profile") {
            Picker("", selection: $selectedProfile) {
              ForEach(profiles, id: \.self) { p in
                Text(p).tag(p)
              }
            }
            .labelsHidden()
          }

          // Name
          formSection("Name") {
            HStack(spacing: 6) {
              Image(systemName: "clock")
                .foregroundStyle(.tertiary)
                .font(.system(size: 11))
              TextField("e.g. nightly-build-check", text: $name)
                .textFieldStyle(.plain)
                .font(.system(.callout, design: .monospaced))
            }
            .padding(8)
            .background(Color(nsColor: .controlBackgroundColor))
            .clipShape(RoundedRectangle(cornerRadius: 6))
          }

          // Cron expression
          formSection("Schedule (cron)") {
            VStack(alignment: .leading, spacing: 4) {
              HStack(spacing: 6) {
                Image(systemName: "calendar.badge.clock")
                  .foregroundStyle(.tertiary)
                  .font(.system(size: 11))
                TextField("0 9 * * 1-5", text: $cronExpression)
                  .textFieldStyle(.plain)
                  .font(.system(.callout, design: .monospaced))
              }
              .padding(8)
              .background(Color(nsColor: .controlBackgroundColor))
              .clipShape(RoundedRectangle(cornerRadius: 6))
              .overlay(
                RoundedRectangle(cornerRadius: 6)
                  .stroke(cronValidationColor, lineWidth: 1)
              )

              HStack(spacing: 12) {
                cronHint("0 9 * * *", label: "daily 9am")
                cronHint("0 2 * * 1", label: "Mon 2am")
                cronHint("*/30 * * * *", label: "every 30m")
              }
            }
          }

          // Task
          formSection("Task") {
            TextEditor(text: $task)
              .font(.system(.body, design: .default))
              .frame(minHeight: 80, maxHeight: 150)
              .padding(6)
              .background(Color(nsColor: .controlBackgroundColor))
              .clipShape(RoundedRectangle(cornerRadius: 6))
              .overlay(
                RoundedRectangle(cornerRadius: 6)
                  .stroke(Color(nsColor: .separatorColor), lineWidth: 0.5)
              )
              .overlay(alignment: .topLeading) {
                if task.isEmpty {
                  Text("Describe what the agent should do on each run...")
                    .font(.body)
                    .foregroundStyle(.tertiary)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 12)
                    .allowsHitTesting(false)
                }
              }
          }

          // Enabled toggle
          formSection("State") {
            Toggle("Enable immediately", isOn: $enabled)
              .toggleStyle(.switch)
              .controlSize(.small)
          }
        }
        .padding(20)
      }

      Divider()

      // Actions
      HStack {
        Spacer()
        Button("Cancel") { isPresented = false }
          .keyboardShortcut(.cancelAction)
        Button("Create Job") {
          let req = CreateScheduledJobRequest(
            name: name.trimmingCharacters(in: .whitespacesAndNewlines),
            profileName: selectedProfile,
            task: task.trimmingCharacters(in: .whitespacesAndNewlines),
            cronExpression: cronExpression.trimmingCharacters(in: .whitespacesAndNewlines),
            enabled: enabled
          )
          onCreateJob?(req)
          isPresented = false
        }
        .buttonStyle(.borderedProminent)
        .keyboardShortcut(.defaultAction)
        .disabled(!canCreate)
      }
      .padding(16)
    }
    .frame(minWidth: 460, maxWidth: 460, minHeight: 480)
    .background(Color(nsColor: .windowBackgroundColor))
    .onAppear {
      if selectedProfile.isEmpty {
        selectedProfile = profiles.first ?? ""
      }
    }
  }

  // MARK: - Helpers

  private func isValidCron(_ expr: String) -> Bool {
    let parts = expr.trimmingCharacters(in: .whitespacesAndNewlines)
      .split(separator: " ", omittingEmptySubsequences: true)
    return parts.count == 5
  }

  private var cronValidationColor: Color {
    let trimmed = cronExpression.trimmingCharacters(in: .whitespacesAndNewlines)
    if trimmed.isEmpty { return Color(nsColor: .separatorColor).opacity(0) }
    return isValidCron(trimmed) ? .green.opacity(0.5) : .red.opacity(0.5)
  }

  private func cronHint(_ expr: String, label: String) -> some View {
    Button {
      cronExpression = expr
    } label: {
      VStack(alignment: .leading, spacing: 1) {
        Text(expr)
          .font(.system(.caption2, design: .monospaced))
          .foregroundStyle(.blue)
        Text(label)
          .font(.system(size: 9))
          .foregroundStyle(.tertiary)
      }
    }
    .buttonStyle(.borderless)
  }

  private func formSection<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
    VStack(alignment: .leading, spacing: 5) {
      Text(title)
        .font(.system(.caption).weight(.semibold))
        .foregroundStyle(.secondary)
      content()
    }
  }
}

// MARK: - Preview

#Preview("Create Scheduled Job") {
  @Previewable @State var show = true
  CreateScheduledJobSheet(
    isPresented: $show,
    profileNames: ["my-app", "webapp", "backend"]
  )
}
