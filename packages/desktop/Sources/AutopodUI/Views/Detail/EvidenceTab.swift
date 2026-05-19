import AutopodClient
import SwiftUI

/// Evidence tab — proof screenshots, generated artifacts, and rendered markdown
/// outputs in one place so the top-level detail nav stays calm.
public struct EvidenceTab: View {
  public let pod: Pod
  public var loadFiles: ((String) async throws -> [SessionFileEntry])?
  public var loadArtifacts: ((String) async throws -> [SessionFileEntry])?
  public var loadContent: ((String, String) async throws -> SessionFileContent)?

  public init(
    pod: Pod,
    loadFiles: ((String) async throws -> [SessionFileEntry])? = nil,
    loadArtifacts: ((String) async throws -> [SessionFileEntry])? = nil,
    loadContent: ((String, String) async throws -> SessionFileContent)? = nil
  ) {
    self.pod = pod
    self.loadFiles = loadFiles
    self.loadArtifacts = loadArtifacts
    self.loadContent = loadContent
  }

  private enum Section: String, CaseIterable {
    case screenshots, artifacts, markdown

    var label: String {
      switch self {
      case .screenshots: "Screenshots"
      case .artifacts: "Artifacts"
      case .markdown: "Markdown"
      }
    }

    var icon: String {
      switch self {
      case .screenshots: "photo.on.rectangle.angled"
      case .artifacts: "doc.on.doc"
      case .markdown: "doc.richtext"
      }
    }
  }

  @State private var selectedSection: Section = .screenshots
  @State private var lightboxRefs: [ScreenshotRef] = []
  @State private var lightboxIndex: Int = 0
  @State private var isLightboxPresented: Bool = false

  private var screenshotSet: [ScreenshotRef] {
    let pageShots = pod.validationChecks?.proofOfWorkScreenshots ?? []
    let acShots = pod.validationChecks?.acChecks?.compactMap { $0.screenshot } ?? []
    let reviewShots = pod.validationChecks?.taskReviewScreenshots ?? []
    return pageShots + acShots + reviewShots
  }

  public var body: some View {
    HSplitView {
      sectionRail
        .frame(minWidth: 150, idealWidth: 170, maxWidth: 210)

      content
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
    .overlay {
      if isLightboxPresented, !lightboxRefs.isEmpty {
        ScreenshotLightbox(
          refs: lightboxRefs,
          currentIndex: $lightboxIndex,
          isPresented: $isLightboxPresented
        )
        .transition(.opacity)
      }
    }
    .animation(.easeInOut(duration: 0.18), value: isLightboxPresented)
  }

  private var sectionRail: some View {
    VStack(alignment: .leading, spacing: 8) {
      Text("Evidence")
        .font(.caption.weight(.semibold))
        .foregroundStyle(.secondary)
        .textCase(.uppercase)
        .tracking(0.4)
        .padding(.horizontal, 12)
        .padding(.top, 12)

      ForEach(Section.allCases, id: \.self) { section in
        Button {
          selectedSection = section
        } label: {
          HStack(spacing: 8) {
            Image(systemName: section.icon)
              .font(.system(size: 12))
              .frame(width: 16)
            Text(section.label)
              .font(.subheadline.weight(selectedSection == section ? .semibold : .regular))
              .lineLimit(1)
            Spacer(minLength: 0)
            if section == .screenshots, !screenshotSet.isEmpty {
              Text("\(screenshotSet.count)")
                .font(.caption2)
                .foregroundStyle(.secondary)
            }
          }
          .foregroundStyle(selectedSection == section ? .primary : .secondary)
          .padding(.horizontal, 10)
          .padding(.vertical, 7)
          .background(
            RoundedRectangle(cornerRadius: 7)
              .fill(selectedSection == section ? Color.white.opacity(0.08) : .clear)
          )
          .contentShape(RoundedRectangle(cornerRadius: 7))
        }
        .buttonStyle(.plain)
      }

      Spacer(minLength: 0)
    }
    .padding(.horizontal, 8)
    .background(Color(nsColor: .controlBackgroundColor).opacity(0.55))
  }

  @ViewBuilder
  private var content: some View {
    switch selectedSection {
    case .screenshots:
      screenshotsPane
    case .artifacts:
      ArtifactsTab(pod: pod, loadArtifacts: loadArtifacts, loadContent: loadContent)
    case .markdown:
      MarkdownTab(pod: pod, loadFiles: loadFiles, loadContent: loadContent)
    }
  }

  private var screenshotsPane: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 16) {
        VStack(alignment: .leading, spacing: 4) {
          HStack(spacing: 8) {
            Image(systemName: "photo.on.rectangle.angled")
              .foregroundStyle(.green)
            Text("Proof of Work")
              .font(.title3.weight(.semibold))
          }
          Text("Screenshots captured by smoke checks, criteria checks, and task review.")
            .font(.caption)
            .foregroundStyle(.secondary)
        }

        if screenshotSet.isEmpty {
          emptyScreenshots
        } else {
          screenshotGrid
        }
      }
      .padding(20)
      .frame(maxWidth: .infinity, alignment: .leading)
    }
  }

  private var screenshotGrid: some View {
    LazyVGrid(columns: [GridItem(.adaptive(minimum: 240), spacing: 12)], spacing: 12) {
      ForEach(Array(screenshotSet.enumerated()), id: \.element.id) { index, shot in
        ZStack(alignment: .bottomLeading) {
          ScreenshotThumbnail(
            ref: shot,
            allRefs: screenshotSet,
            onOpen: { openLightbox($0) },
            maxHeight: 220,
            fillMode: true
          )
          .frame(maxWidth: .infinity)
          .frame(height: 180)
          .clipped()

          HStack(spacing: 6) {
            Text(shot.source.rawValue.uppercased())
              .font(.system(size: 8, weight: .bold, design: .monospaced))
              .foregroundStyle(.white.opacity(0.9))
              .padding(.horizontal, 5)
              .padding(.vertical, 2)
              .background(Color.white.opacity(0.16), in: Capsule())
            Text(shot.label)
              .font(.system(size: 10, design: .monospaced))
              .foregroundStyle(.white)
              .lineLimit(1)
              .truncationMode(.middle)
            Spacer(minLength: 0)
          }
          .padding(7)
          .background(Color.black.opacity(0.62))
        }
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color.secondary.opacity(0.18), lineWidth: 1))
        .contentShape(RoundedRectangle(cornerRadius: 8))
        .onTapGesture { openLightbox(index) }
      }
    }
  }

  private var emptyScreenshots: some View {
    VStack(spacing: 10) {
      Image(systemName: "photo.on.rectangle")
        .font(.system(size: 32))
        .foregroundStyle(.tertiary)
      Text("No screenshots captured yet")
        .font(.subheadline)
        .foregroundStyle(.secondary)
      Text("Smoke tests, criteria checks, and task review screenshots will appear here.")
        .font(.caption)
        .foregroundStyle(.tertiary)
        .multilineTextAlignment(.center)
    }
    .frame(maxWidth: .infinity)
    .padding(.vertical, 60)
  }

  private func openLightbox(_ index: Int) {
    lightboxRefs = screenshotSet
    lightboxIndex = index
    isLightboxPresented = true
  }
}

#Preview("Evidence") {
  EvidenceTab(pod: MockData.validated)
    .frame(width: 900, height: 600)
}
