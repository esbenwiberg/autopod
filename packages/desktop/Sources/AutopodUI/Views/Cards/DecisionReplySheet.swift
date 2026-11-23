import SwiftUI
import MarkdownUI

/// Production card reply content; reads the live, source-bound pod after hydration.
struct DecisionReplySheet: View {
  let podID: String
  let actions: DecisionReplyActions
  let dismiss: () -> Void
  @State private var surface = DecisionReplySurface()

  var body: some View {
    let observed = actions.pod(podID)
    let pod = observed?.status == .awaitingInput ? observed : nil
    let context = DecisionReplyContext(handlerID: actions.contextID, podID: podID, decisionID: pod?.escalationId, awaitingInput: pod != nil)
    return content(pod: pod, interaction: DecisionReplyInteraction(context: context, actions: actions))
  }

  private func content(pod: Pod?, interaction: DecisionReplyInteraction) -> some View {
    let context = interaction.context
    let snapshot = interaction.snapshot
    return VStack(alignment: .leading, spacing: 0) {
      ScrollView {
        VStack(alignment: .leading, spacing: 12) {
          Markdown(pod?.escalationQuestion ?? "No unanswered question is available.")
            .markdownTheme(.autopod)
            .textSelection(.enabled)
            .frame(maxWidth: .infinity, alignment: .leading)
          if pod?.escalationType == "action_approval" {
            HStack(spacing: 8) {
              Button { submit(interaction, selected: "approved") } label: { Label("Approve", systemImage: "checkmark.circle.fill") }
                .buttonStyle(.borderedProminent).tint(.green)
                .accessibilityIdentifier("decision-sheet-approve")
              Button { submit(interaction, selected: "rejected") } label: { Label("Reject", systemImage: "xmark.circle.fill") }
                .buttonStyle(.borderedProminent).tint(.red)
                .accessibilityIdentifier("decision-sheet-reject")
            }
            .disabled(!snapshot.canSubmit)
          } else if let options = pod?.escalationOptions, !options.isEmpty {
            VStack(alignment: .leading, spacing: 6) {
              ForEach(options, id: \.self) { option in
                DecisionOptionButton(option: option) { submit(interaction, selected: option) }
                  .disabled(!snapshot.canSubmit)
                  .accessibilityIdentifier("decision-sheet-option-\(option)")
              }
            }
            Divider()
            Label("Or type a custom reply:", systemImage: "pencil")
              .font(.caption).foregroundStyle(.secondary)
          }
        }.padding(20).padding(.bottom, 4)
      }
      Divider()
      VStack(alignment: .leading, spacing: 10) {
        if pod?.escalationType != "action_approval" {
          HStack(alignment: .bottom, spacing: 8) {
            TextField("Type your reply…", text: Binding(get: { interaction.snapshot.text }, set: { interaction.edit($0) }), axis: .vertical)
              .lineLimit(1...8)
              // Match the multiline Overview editor. Leave the question's ScrollView
              // to absorb height changes instead of compressing the reply.
              .textFieldStyle(.plain)
              .fixedSize(horizontal: false, vertical: true)
              .padding(8)
              .background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 6))
              .layoutPriority(1)
              .disabled(!snapshot.canEdit)
              .onSubmit { submit(interaction) }
            Button { submit(interaction) } label: { Image(systemName: "paperplane.fill") }
              .buttonStyle(.borderedProminent).tint(.orange)
              .disabled(!snapshot.canSubmit || snapshot.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
          }
        }
        DecisionReplyNotice(snapshot: snapshot, surface: surface, unknown: pod?.escalationId == nil) {
          surface.prepareTask(context, actions: actions)
        }
        HStack {
          Spacer()
          Button("Cancel", role: .cancel) {
            interaction.discard()
            dismiss()
          }.controlSize(.small).accessibilityIdentifier("decision-sheet-cancel")
        }
      }.padding(20)
    }
    .frame(minWidth: 560, maxWidth: 760, minHeight: 200, maxHeight: 600)
    .onAppear { prepareSurface(context) }
    .onChange(of: context) { _, value in prepareSurface(value) }
    .onDisappear { surface.unmount() }
  }

  private func prepareSurface(_ context: DecisionReplyContext) {
    surface.mount(context)
    surface.prepareTask(context, actions: actions)
  }

  private func submit(_ interaction: DecisionReplyInteraction, selected: String? = nil) {
    let captured = interaction.context
    let lease = surface.lease
    let task = interaction.submit(selected: selected)
    let record = interaction.snapshot.recordID
    Task {
      let outcome = await task.value
      if outcome == .acknowledged, surface.canDismiss(captured, lease: lease, actions: actions, record: record) {
        dismiss()
      }
    }
  }
}
