import AutopodClient
import Foundation

/// Shares the exact LaunchRequest JSON format with `ap run --config`, including its retry key.
enum LaunchRequestJournal {
  static func saveSeries(_ request: CreateSeriesRequest, directory: URL? = nil) throws -> URL {
    guard request.requestId.range(of: #"^[a-zA-Z0-9_.-]{1,128}$"#, options: .regularExpression) != nil else {
      throw LaunchJSONError.invalid("A stable series request ID is required")
    }
    let folder = directory ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".autopod/series-launches", isDirectory: true)
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    let url = folder.appendingPathComponent("\(request.requestId).json")
    let encoder = JSONEncoder(); encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
    let data = try encoder.encode(request)
    if FileManager.default.fileExists(atPath: url.path) {
      let old = try JSONDecoder().decode(ConfigurationJSON.self, from: Data(contentsOf: url))
      let new = try JSONDecoder().decode(ConfigurationJSON.self, from: data)
      guard old == new else { throw LaunchJSONError.invalid("This request ID belongs to a different saved series") }
      return url
    }
    try data.write(to: url, options: .withoutOverwriting)
    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    let file = try FileHandle(forWritingTo: url)
    try file.synchronize(); try file.close()
    return url
  }
  static func save(_ request: ComposableLaunchRequest, directory: URL? = nil) throws -> URL {
    guard let id = request.requestId, !id.isEmpty, id.range(of: #"^[a-zA-Z0-9_.-]{1,128}$"#, options: .regularExpression) != nil else {
      throw LaunchJSONError.invalid("A stable launch request ID is required")
    }
    let folder = directory ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".autopod/launches", isDirectory: true)
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    let url = folder.appendingPathComponent("\(id).json")
    let encoder = JSONEncoder(); encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
    let data = try encoder.encode(request)
    if FileManager.default.fileExists(atPath: url.path) {
      guard try ComposableLaunchRequest.decodeJSON(Data(contentsOf: url)) == request else { throw LaunchJSONError.invalid("This request ID belongs to a different saved launch") }
      return url
    }
    // Foundation's exclusive create prevents overwriting a different request with the same key.
    try data.write(to: url, options: .withoutOverwriting)
    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    let file = try FileHandle(forWritingTo: url)
    try file.synchronize(); try file.close()
    return url
  }
}
