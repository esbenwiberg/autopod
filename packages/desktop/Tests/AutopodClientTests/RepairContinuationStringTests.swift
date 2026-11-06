@testable import AutopodClient
import Foundation
import Testing

private struct RepairStringCase: Decodable {
  let name: String
  let kind: String
  let path: [String]
  let value: String
  let success: Bool
  let canonicalValue: String?
  let bindingDigest: String?
  let aliasKey: String?
  let retainOriginal: Bool?
}
private func stringFixture(_ name: String) throws -> Data {
  let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
    .appendingPathComponent("Fixtures/" + name)
  return try Data(contentsOf: url)
}
private func stringCases() throws -> [RepairStringCase] {
  try JSONDecoder().decode([RepairStringCase].self, from: stringFixture("repair-continuation-strings.json"))
}
private func updateStringNode(_ root: Any, path: ArraySlice<String>, transform: (Any) -> Any) -> Any {
  guard let key = path.first else { return transform(root) }
  if var array = root as? [Any], let index = Int(key) {
    array[index] = updateStringNode(array[index], path: path.dropFirst(), transform: transform)
    return array
  }
  var object = root as! [String: Any]
  object[key] = updateStringNode(object[key] ?? NSNull(), path: path.dropFirst(), transform: transform)
  return object
}
private func stringWire(_ vector: RepairStringCase) throws -> Data {
  let small = try JSONSerialization.jsonObject(with: stringFixture("repair-continuation-v1.json")) as! [String: Any]
  let producer = try JSONSerialization.jsonObject(with: stringFixture("repair-continuation-backend.json")) as! [String: Any]
  var wire = (vector.kind == "operation" ? producer["validated"] : small[vector.kind]) as! [String: Any]
  if vector.path.first == "refusals" { wire["refusals"] = [["code": "unavailable", "message": "Before"]] }
  let value = vector.canonicalValue ?? vector.value
  wire = updateStringNode(wire, path: vector.path[...]) { _ in value } as! [String: Any]
  if vector.path == ["qualification", "binding", "source", "repository"] {
    wire = updateStringNode(wire, path: ["codingFinalSource", "source", "repository"][...]) { _ in value } as! [String: Any]
  }
  if let digest = vector.bindingDigest {
    wire = updateStringNode(wire, path: ["qualification", "bindingDigest"][...]) { _ in digest } as! [String: Any]
  }
  if let alias = vector.aliasKey, vector.retainOriginal != true {
    wire = updateStringNode(wire, path: vector.path.dropLast()) { node in
      var object = node as! [String: Any]
      object.removeValue(forKey: vector.path.last!)
      object[alias] = value // Remove first: Swift itself equates Kelvin K with ASCII K.
      return object
    } as! [String: Any]
    let q = wire["qualification"] as! [String: Any]
    let raw = try JSONDecoder().decode(RepairBindingCanonicalJSON.self,
      from: JSONSerialization.data(withJSONObject: q["binding"]!))
    // Backend-generated consistent digest: rejection must NOT rely on a stale hash.
    #expect(raw.digest == vector.bindingDigest)
    #expect(throws: (any Error).self) { try raw.validateBindingShape() }
  }
  var data = try JSONSerialization.data(withJSONObject: wire)
  if vector.retainOriginal == true {
    // Construct both spellings as raw JSON: a Swift Dictionary would coalesce
    // these equivalent keys BEFORE serialization. Foundation may coalesce them
    // during decoding too; we assert refusal, not raw-parser duplicate detection.
    let body = String(decoding: data, as: UTF8.self)
      .replacingOccurrences(of: "\"resourceKey\":", with: "\"resourceKey\":\"alias-resource\",\"resourceKey\":")
    data = Data(body.utf8)
  }
  return data
}

@Suite @MainActor struct RepairContinuationStringTests {
  @Test func mirrorsActualPinnedSchemaScalarBoundsAndExactTrim() throws {
    for vector in try stringCases() {
      let data = try stringWire(vector)
      var accepted = false
      do {
        switch vector.kind {
        case "request":
          let request = try JSONDecoder().decode(RepairContinuationRequestV1.self, from: data)
          try request.validate()
          if vector.path == ["reason"] {
            #expect(request.reason.utf8.elementsEqual(RepairContinuationRequestV1.canonicalReason(vector.value).utf8))
          }
        case "preview":
          let preview = try JSONDecoder().decode(RepairContinuationPreviewV1.self, from: data)
          try preview.validate(podId: "pod", sourceHead: String(repeating: "c", count: 40), profileId: "reviewed-profile")
        default:
          let operation = try JSONDecoder().decode(RepairContinuationOperationV1.self, from: data)
          try operation.validate(podId: operation.podId, requestId: operation.request.id)
          if vector.path == ["qualification", "binding", "resourceKey"] {
            #expect(operation.qualification!.binding.resourceKey.utf8.elementsEqual(vector.value.utf8))
          }
          if vector.path == ["qualification", "binding", "source", "repository"] {
            #expect(operation.qualification!.binding.source.repository.utf8.elementsEqual(vector.value.utf8))
          }
        }
        accepted = true
      } catch {}
      #expect(accepted == vector.success, "\(vector.name)")
    }
  }

  @Test func transportAcceptsLongAstralIdentityAndRefusesConsistentDigestAliases() async throws {
    for vector in try stringCases().filter({ $0.aliasKey != nil || $0.name == "review-resource-1025-astral" }) {
      let body = String(decoding: try stringWire(vector), as: UTF8.self)
      let baseline = try JSONSerialization.jsonObject(with: stringFixture("repair-continuation-backend.json")) as! [String: Any]
      let original = try JSONDecoder().decode(RepairContinuationOperationV1.self,
        from: JSONSerialization.data(withJSONObject: baseline["validated"]!))
      try await withPodStoreLifetimeFixture { f in
        let task = f.startResult {
          do { _ = try await f.apiA.observeRepairContinuation(original.podId, requestId: original.request.id); return "accepted" }
          catch { return "refused" }
        }
        try await f.next(f.a, "/pods/\(original.podId)/repair-continuation-v1/requests/\(original.request.id)").respond(body: body)
        #expect(await task.value == (vector.success ? "accepted" : "refused"), "\(vector.name)")
        #expect(f.a.requests.count == 1 && f.a.requests[0].httpMethod == "GET")
      }
    }
  }
}
