import Foundation

/// Pull actionable failures out of verbose command output without treating successful checks as errors.
public func validationFailureSummary(_ output: String) -> String? {
  let clean = output.replacingOccurrences(of: "\u{001B}\\[[0-9;]*m", with: "", options: .regularExpression)
  let lines = clean.components(separatedBy: .newlines)
  if let index = lines.firstIndex(where: {
    let line = $0.trimmingCharacters(in: .whitespaces)
    return !line.hasPrefix("✓") && !line.hasPrefix("✔")
      && line.contains("non-capsule commits not covered by capsule commit_range:")
  }) {
    return String(lines[max(0, index - 1)...min(lines.count - 1, index + 1)]
      .joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines).prefix(1_200))
  }
  let failures = lines.indices.filter { index in
    let line = lines[index].trimmingCharacters(in: .whitespaces)
    guard !line.hasPrefix("✓"), !line.hasPrefix("✔") else { return false }
    return line.range(of: #"^(✗|×|FAIL\b|ERROR\b|Error:|AssertionError\b|error TS[0-9]+|[0-9]+:[0-9]+\s+error\b|ESLint found too many warnings)"#,
                      options: [.regularExpression, .caseInsensitive]) != nil
  }
  guard !failures.isEmpty else { return nil }
  var selected = Set<Int>()
  for index in failures.suffix(3) {
    for next in index...min(index + 2, lines.count - 1) { selected.insert(next) }
  }
  return String(selected.sorted().map { lines[$0] }.joined(separator: "\n")
    .trimmingCharacters(in: .whitespacesAndNewlines).prefix(1_200))
}
