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
