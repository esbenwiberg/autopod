import AppKit
import AutopodClient
import ImageIO
import SwiftUI
import UniformTypeIdentifiers

/// Original user inputs belong beside the task, not among generated evidence.
struct ReferenceAttachmentsCard: View {
  let podId: String
  @State private var model: ReferenceAttachmentsModel
  @State private var selection: Selection?
  @State private var retry = 0

  init(podId: String, actions: LaunchConfigurationActions) {
    self.podId = podId
    _model = State(initialValue: ReferenceAttachmentsModel(actions: actions))
  }

  private struct Selection: Identifiable { let id: Int }

  var body: some View {
    Group {
      if model.isLoading || model.error != nil || model.bundle != nil {
        VStack(alignment: .leading, spacing: 12) {
          Label("Reference attachments", systemImage: "paperclip")
            .font(.subheadline.weight(.semibold))
            .accessibilityIdentifier("reference-attachments-card")
          Text("Provided inputs · not added to source")
            .font(.caption).foregroundStyle(.secondary)
          if model.isLoading {
            ProgressView("Loading references…").controlSize(.small)
          } else if let error = model.error {
            Text("Couldn't load references: \(error)").font(.caption).foregroundStyle(.secondary)
            Button("Retry") { retry += 1 }
              .accessibilityIdentifier("reference-attachments-retry")
          } else if let bundle = model.bundle {
            ForEach(Array(bundle.files.enumerated()), id: \.offset) { index, file in
              attachmentRow(file, index: index)
            }
          }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(.secondary.opacity(0.12)))
      }
    }
    .task(id: "\(podId):\(retry)") { await model.load(podId: podId) }
    .sheet(item: $selection) { selection in
      if let bundle = model.bundle, bundle.files.indices.contains(selection.id) {
        ReferenceAttachmentPreview(file: bundle.files[selection.id], index: selection.id, model: model)
      }
    }
  }

  private func attachmentRow(_ file: InputFileManifest, index: Int) -> some View {
    HStack(spacing: 12) {
      Button { selection = Selection(id: index) } label: {
        HStack(spacing: 12) {
          thumbnail(file, index: index)
            .frame(width: 84, height: 64)
            .background(.black.opacity(0.12), in: RoundedRectangle(cornerRadius: 6))
            .clipped()
          VStack(alignment: .leading, spacing: 4) {
            Text(file.path).font(.callout.weight(.medium)).lineLimit(2).truncationMode(.middle)
            Text("\(file.formattedSize) · \(file.mediaType)")
              .font(.caption).foregroundStyle(.secondary)
            Text(file.hasRasterPreview || file.hasTextPreview ? "Preview" : "View file details / Save…")
              .font(.caption).foregroundStyle(Color.accentColor)
          }
          Spacer(minLength: 0)
          Image(systemName: "arrow.up.left.and.arrow.down.right").foregroundStyle(.secondary)
        }
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .accessibilityLabel("Preview reference \(file.path), \(file.formattedSize)")
      .accessibilityIdentifier("reference-attachment-\(index)")
    }
    .task {
      if file.hasRasterPreview { await model.loadFile(index) }
    }
  }

  @ViewBuilder private func thumbnail(_ file: InputFileManifest, index: Int) -> some View {
    if file.hasRasterPreview, let data = model.bytes[index], let image = referenceImage(data, maxPixels: 200) {
      Image(nsImage: image).resizable().scaledToFit()
    } else if model.loadingFiles.contains(index) {
      ProgressView().controlSize(.small)
    } else {
      Image(systemName: model.fileErrors[index] != nil ? "exclamationmark.triangle" : (file.hasRasterPreview ? "photo" : "doc.text"))
        .font(.title2).foregroundStyle(.secondary)
    }
  }
}

struct ReferenceAttachmentPreview: View {
  let file: InputFileManifest
  let index: Int
  let model: ReferenceAttachmentsModel
  @Environment(\.dismiss) private var dismiss
  @State private var exporting = false
  @State private var exportError: String?
  @State private var isZoomed = false

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack {
        VStack(alignment: .leading, spacing: 4) {
          Text(file.path).font(.headline).lineLimit(2).truncationMode(.middle).textSelection(.enabled)
          Text("Provided input · \(file.formattedSize) · \(file.mediaType)")
            .font(.caption).foregroundStyle(.secondary)
        }
        Spacer()
        Button("Save…") { exporting = true }
          .disabled(model.bytes[index] == nil)
          .accessibilityIdentifier("reference-attachment-save")
        Button("Done") { dismiss() }.keyboardShortcut(.cancelAction)
          .accessibilityIdentifier("reference-attachment-close")
      }
      Divider()
      content.frame(maxWidth: .infinity, maxHeight: .infinity)
      if file.hasRasterPreview, model.bytes[index] != nil {
        Button(isZoomed ? "Fit image" : "Zoom in") { isZoomed.toggle() }
          .accessibilityIdentifier("reference-attachment-zoom")
      }
      if let exportError { Text(exportError).font(.caption).foregroundStyle(.red) }
    }
    .padding(20)
    .frame(width: 800, height: 680)
    .background(Color(nsColor: .windowBackgroundColor))
    .task { await model.loadFile(index) }
    .fileExporter(
      isPresented: $exporting,
      document: ReferenceFileDocument(bytes: model.bytes[index] ?? Data()),
      contentType: UTType(mimeType: file.mediaType) ?? .data,
      defaultFilename: URL(fileURLWithPath: file.path).lastPathComponent
    ) { result in
      if case .failure(let error) = result { exportError = error.localizedDescription }
    }
  }

  @ViewBuilder private var content: some View {
    if let error = model.fileErrors[index] {
      VStack(spacing: 12) {
        Text("Couldn't load reference").font(.headline)
        Text(error).foregroundStyle(.secondary).textSelection(.enabled)
        Button("Retry") { Task { await model.loadFile(index) } }
          .accessibilityIdentifier("reference-attachment-file-retry")
      }
    } else if let data = model.bytes[index] {
      if file.hasRasterPreview, let image = referenceImage(data, maxPixels: 4096) {
        if isZoomed {
          ScrollView([.horizontal, .vertical]) {
            Image(nsImage: image)
              .accessibilityLabel("Reference image \(file.path)")
              .accessibilityIdentifier("reference-attachment-image")
          }
        } else {
          Image(nsImage: image).resizable().scaledToFit()
            .accessibilityLabel("Reference image \(file.path)")
            .accessibilityIdentifier("reference-attachment-image")
        }
      } else if file.hasTextPreview {
        VStack(alignment: .leading, spacing: 8) {
          Text("Source preview · active content is not executed")
            .font(.caption).foregroundStyle(.secondary)
          ScrollView([.horizontal, .vertical]) {
            Text(String(decoding: data.prefix(256 * 1024), as: UTF8.self))
              .font(.system(.callout, design: .monospaced)).textSelection(.enabled)
              .frame(maxWidth: .infinity, alignment: .topLeading)
          }
          if data.count > 256 * 1024 {
            Text("Preview limited to 256 KiB. Save to view the complete file.").font(.caption)
          }
        }
      } else {
        ContentUnavailableView("Preview unavailable", systemImage: "doc", description: Text("Save the original file to open it in an application of your choice."))
      }
    } else {
      ProgressView("Loading reference…")
    }
  }
}

/// Decode only raster formats selected by the manifest, with bounded preview dimensions.
private func referenceImage(_ data: Data, maxPixels: Int) -> NSImage? {
  guard let source = CGImageSourceCreateWithData(data as CFData, nil),
    let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [
      kCGImageSourceCreateThumbnailFromImageAlways: true,
      kCGImageSourceCreateThumbnailWithTransform: true,
      kCGImageSourceThumbnailMaxPixelSize: maxPixels,
    ] as CFDictionary) else { return nil }
  return NSImage(cgImage: image, size: .zero)
}

private struct ReferenceFileDocument: FileDocument {
  static let readableContentTypes: [UTType] = [.data]
  var bytes: Data
  init(bytes: Data) { self.bytes = bytes }
  init(configuration: ReadConfiguration) throws { bytes = configuration.file.regularFileContents ?? Data() }
  func fileWrapper(configuration: WriteConfiguration) throws -> FileWrapper { FileWrapper(regularFileWithContents: bytes) }
}
