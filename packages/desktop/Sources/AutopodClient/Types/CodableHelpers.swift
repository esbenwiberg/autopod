import Foundation

// MARK: - Bool/Int coercion helpers
// SQLite stores booleans as integers (0/1). When the daemon serializes
// these values via JSON.parse of a JSON column, they can come through as
// numbers instead of booleans. These helpers handle both representations.

func decodeBoolOrInt<K: CodingKey>(
  _ container: KeyedDecodingContainer<K>, key: K
) throws -> Bool {
  if let v = try? container.decode(Bool.self, forKey: key) { return v }
  let intVal = try container.decode(Int.self, forKey: key)
  return intVal != 0
}

func decodeBoolOrIntIfPresent<K: CodingKey>(
  _ container: KeyedDecodingContainer<K>, key: K
) throws -> Bool? {
  if let v = try? container.decodeIfPresent(Bool.self, forKey: key) { return v }
  guard let intVal = try container.decodeIfPresent(Int.self, forKey: key) else { return nil }
  return intVal != 0
}

/// Decodes a field that may be either a `String` or an array of objects with a `text` key.
/// Legacy daemon events (pre-c97af9a) stored tool_result `output` as a content-block array;
/// newer events always emit a plain string. Either way we return a `String?`.
func decodeStringOrArray<K: CodingKey>(
  _ container: KeyedDecodingContainer<K>, key: K
) throws -> String? {
  // Try plain string first (the common case).
  if let s = try? container.decodeIfPresent(String.self, forKey: key) { return s }
  // Fall back to an array of objects — join their `text` fields.
  guard var nested = try? container.nestedUnkeyedContainer(forKey: key) else { return nil }
  var parts: [String] = []
  while !nested.isAtEnd {
    if let obj = try? nested.nestedContainer(keyedBy: DynamicCodingKey.self) {
      let textKey = DynamicCodingKey(stringValue: "text")
      let text = try? obj.decodeIfPresent(String.self, forKey: textKey)
      parts.append(text ?? "")
    } else {
      _ = try? nested.decode(AnyCodable.self)
    }
  }
  let joined = parts.joined(separator: "\n")
  return joined.isEmpty ? nil : joined
}

/// Minimal CodingKey for dynamic string keys used in `decodeStringOrArray`.
private struct DynamicCodingKey: CodingKey {
  var stringValue: String
  var intValue: Int? { nil }
  init(stringValue: String) { self.stringValue = stringValue }
  init?(intValue: Int) { nil }
}
