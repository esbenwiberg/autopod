import Foundation
import Testing
@testable import AutopodUI

@MainActor
@Test func managedPodsHaveASeparateSidebarDestination() {
  #expect(SidebarItem.managedPods.label == "Managed Pods")
  #expect(MainView.filterPods([], for: .managedPods).isEmpty)
}

@Test func managedPodCardsUseCompactReadableIdentity() {
  #expect(
    managedPodDisplayName("managed-95b3a353-a98b-470c-aafb-af716aee0fd1")
      == "managed-95b3a353"
  )
  #expect(managedPodDisplayName("external-attempt") == "external-attempt")
}

@Test func managedValidationLabelsStayOperatorFriendly() {
  #expect(managedValidationLabel(nil) == "Not Requested")
  #expect(managedValidationLabel("disabled") == "Disabled")
  #expect(managedValidationLabel("in-progress") == "In Progress")
}

@Test func managedArtifactViewerPreviewsSafeReadableFormats() {
  #expect(managedArtifactPreviewKind(path: "research.md", mediaType: "text/markdown") == .markdown)
  #expect(managedArtifactPreviewKind(path: "report.html", mediaType: "application/octet-stream") == .text)
  #expect(managedArtifactPreviewKind(path: "evidence.json", mediaType: "application/json") == .text)
  #expect(managedArtifactPreviewKind(path: "shot.png", mediaType: "image/png") == .image)
  #expect(managedArtifactPreviewKind(path: "archive.zip", mediaType: "application/zip") == .unavailable)
}

@Test func managedArtifactViewerPrettyPrintsJSON() {
  let text = managedArtifactDisplayText(Data(#"{"ok":true}"#.utf8), path: "receipt.json")
  #expect(text?.contains("\n") == true)
  #expect(text?.contains(#""ok" : true"#) == true)
}

@Test func managedHTMLPreviewIsSandboxedBeforeArtifactMarkup() {
  let source = #"<script>fetch('https://example.test')</script><h1>Report</h1>"#
  let rendered = managedSandboxedHTML(source)
  #expect(managedArtifactIsHTML("reports/index.HTML"))
  #expect(rendered.contains("default-src 'none'"))
  #expect(rendered.contains("form-action 'none'"))
  #expect(rendered.range(of: "Content-Security-Policy")!.lowerBound < rendered.range(of: source)!.lowerBound)
}
