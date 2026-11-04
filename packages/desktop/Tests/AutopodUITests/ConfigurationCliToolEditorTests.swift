import AppKit
import AutopodClient
import SwiftUI
import Testing
@testable import AutopodUI

@MainActor @Test(arguments: ["npm", "github-source", "github-release"])
func configurationCliToolEditorFitsAndPreservesSource(_ type: String) throws {
  let source: [String: ConfigurationJSON]
  switch type {
  case "github-source": source = ["type": .string(type), "repository": .string("org/tool"), "commit": .string(String(repeating: "a", count: 40)), "buildCommands": .array([.string("npm ci"), .string("npm run build")]), "executable": .string("dist/cli.js")]
  case "github-release": source = ["type": .string(type), "repository": .string("org/tool"), "tag": .string("v1.2.3"), "assets": .array([.object(["platform": .string("linux/amd64"), "asset": .string("tool.tar.gz"), "sha256": .string(String(repeating: "b", count: 64)), "format": .string("tar.gz"), "executable": .string("bin/tool")])])]
  default: source = ["type": .string("npm"), "package": .string("@example/tool"), "version": .string("1.2.3"), "executable": .string("tool")]
  }
  let fields: [String: ConfigurationJSON] = ["name": .string("tool"), "description": .string("Learn from a fix"), "instructions": .string("Run tool --help. Keep normal validation and review."), "usage": .string("instructed"), "verifyArgs": .array([.string("--help")]), "requiredCapabilities": .array([.string("node")]), "source": .object(source)]
  let view = ScrollView { ConfigurationCliToolEditor(fields: .constant(fields)).padding() }.frame(width: 640, height: 600)
  let hosting = NSHostingView(rootView: view)
  let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 640, height: 600), styleMask: [.titled], backing: .buffered, defer: false)
  window.contentView = hosting
  window.layoutIfNeeded()
  hosting.layoutSubtreeIfNeeded()
  #expect(hosting.fittingSize.width <= 640)
  #expect(hosting.fittingSize.height <= 600)
  let encoded = try JSONEncoder().encode(ConfigurationJSON.object(fields))
  let decoded = try JSONDecoder().decode(ConfigurationJSON.self, from: encoded)
  #expect(decoded["source"]?.object == source)
  #expect(ConfigurationEditorArea.areas(for: .toolPack).contains(.software))
}
