import SwiftUI

/// Sheet for spawning a fix pod with optional reviewer instructions.
struct SpawnFixSheet: View {
    let podId: String
    @Binding var message: String
    @Binding var isPresented: Bool
    let onSpawn: (String) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Spawn Fix Pod")
                .font(.headline)

            Text("Paste reviewer comments or instructions for the fix pod. Leave blank to auto-detect CI failures and review comments from the PR.")
                .font(.subheadline)
                .foregroundStyle(.secondary)

            TextEditor(text: $message)
                .font(.body)
                .frame(minHeight: 120)
                .overlay(
                    RoundedRectangle(cornerRadius: 6)
                        .stroke(Color.secondary.opacity(0.3), lineWidth: 1)
                )

            HStack {
                Spacer()
                Button("Cancel") {
                    isPresented = false
                }
                .keyboardShortcut(.escape)
                Button("Spawn Fix Pod") {
                    onSpawn(message)
                    isPresented = false
                }
                .keyboardShortcut(.return)
                .buttonStyle(.borderedProminent)
            }
        }
        .padding(20)
        .frame(minWidth: 400, idealWidth: 480)
    }
}
