import AutopodClient
import SwiftUI

struct ConfigurationCliToolEditor: View {
  @Binding var fields: [String: ConfigurationJSON]
  private var source: Binding<[String: ConfigurationJSON]> {
    Binding(get: { fields["source"]?.object ?? [:] }, set: { fields["source"] = .object($0) })
  }
  private var sourceType: String { source.wrappedValue["type"]?.string ?? "npm" }
  private func values(_ key: String) -> Binding<[ConfigurationJSON]> {
    Binding(get: { fields[key]?.array ?? [] }, set: { fields[key] = .array($0) })
  }
  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      ConfigurationTextValue(title: "Command on PATH", fields: $fields, key: "name")
      ConfigurationTextValue(title: "Purpose", fields: $fields, key: "description")
      Picker("Usage guidance", selection: Binding(get: { fields["usage"]?.string ?? "instructed" }, set: { fields["usage"] = .string($0) })) {
        Text("Only when requested").tag("instructed")
        Text("Agent may choose when useful").tag("discretionary")
      }
      ConfigurationTextValue(title: "When and how to use it (examples, prerequisites, side effects)", fields: $fields, key: "instructions", multiline: true)
      ConfigurationStringListEditor(title: "Offline verification arguments", values: values("verifyArgs"))
      ConfigurationStringListEditor(title: "Required environment capabilities", values: values("requiredCapabilities"))
      Picker("Public installation source", selection: Binding(get: { sourceType }, set: { type in
        switch type {
        case "github-source": source.wrappedValue = ["type": .string(type), "repository": .string(""), "commit": .string(""), "buildCommands": .array([]), "executable": .string("")]
        case "github-release": source.wrappedValue = ["type": .string(type), "repository": .string(""), "tag": .string(""), "assets": .array([])]
        default: source.wrappedValue = ["type": .string("npm"), "package": .string(""), "version": .string(""), "executable": .string("")]
        }
      })) {
        Text("npm package · exact version").tag("npm")
        Text("GitHub source · pinned commit").tag("github-source")
        Text("GitHub release · verified checksum").tag("github-release")
      }
      sourceFields
      Text("Installation recipes run as the worker user during image building. Only use trusted software and build commands. Usage guidance does not grant extra access or enforce a security boundary.")
        .font(.caption).foregroundStyle(.secondary)
    }
  }
  @ViewBuilder private var sourceFields: some View {
    if sourceType == "npm" {
      ConfigurationTextValue(title: "npm package", fields: source, key: "package")
      ConfigurationTextValue(title: "Exact version", fields: source, key: "version")
      ConfigurationTextValue(title: "Package executable name", fields: source, key: "executable")
    } else {
      ConfigurationTextValue(title: "GitHub owner/repository", fields: source, key: "repository")
      if sourceType == "github-source" {
        ConfigurationTextValue(title: "Full commit SHA (40 characters)", fields: source, key: "commit")
        ConfigurationTextValue(title: "Executable path in checkout", fields: source, key: "executable")
        ConfigurationStringListEditor(title: "Trusted build commands", values: Binding(get: { source.wrappedValue["buildCommands"]?.array ?? [] }, set: { source.wrappedValue["buildCommands"] = .array($0) }))
      } else {
        ConfigurationTextValue(title: "Release tag", fields: source, key: "tag")
        ConfigurationObjectListEditor(title: "Platform assets", values: Binding(get: { source.wrappedValue["assets"]?.array ?? [] }, set: { source.wrappedValue["assets"] = .array($0) }), initial: {
          ["platform": .string("linux/amd64"), "asset": .string(""), "sha256": .string(""), "format": .string("binary")]
        }) { asset in
          ConfigurationCliReleaseAssetEditor(fields: asset)
        }
      }
    }
  }
}

private struct ConfigurationCliReleaseAssetEditor: View {
  @Binding var fields: [String: ConfigurationJSON]
  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      Picker("Platform", selection: Binding(get: { fields["platform"]?.string ?? "linux/amd64" }, set: { fields["platform"] = .string($0) })) {
        Text("Linux amd64").tag("linux/amd64")
        Text("Linux arm64").tag("linux/arm64")
      }
      ConfigurationTextValue(title: "Release asset filename", fields: $fields, key: "asset")
      ConfigurationTextValue(title: "SHA-256 checksum", fields: $fields, key: "sha256")
      Picker("Format", selection: Binding(get: { fields["format"]?.string ?? "binary" }, set: { format in
        fields["format"] = .string(format)
        if format == "binary" { fields.removeValue(forKey: "executable") }
      })) {
        Text("Executable binary").tag("binary")
        Text("tar.gz archive").tag("tar.gz")
      }
      if fields["format"]?.string == "tar.gz" {
        ConfigurationTextValue(title: "Executable member path in archive", fields: $fields, key: "executable")
      }
    }
  }
}
