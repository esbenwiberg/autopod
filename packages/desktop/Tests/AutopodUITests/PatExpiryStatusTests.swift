import Foundation
import Testing
@testable import AutopodUI

@Test func patExpiryStatusClassifiesMissingInvalidSoonAndExpired() {
  var components = DateComponents()
  components.year = 2026
  components.month = 5
  components.day = 20
  components.hour = 12
  let now = Calendar(identifier: .gregorian).date(from: components)!

  #expect(Profile.patExpiryStatus(nil, now: now) == .none)
  #expect(Profile.patExpiryStatus("2026-02-30", now: now) == .invalid)
  #expect(Profile.patExpiryStatus("2026-05-21", now: now) == .soon(daysRemaining: 1))
  #expect(Profile.patExpiryStatus("2026-06-15", now: now) == .ok(daysRemaining: 26))
  #expect(Profile.patExpiryStatus("2026-05-19", now: now) == .expired(daysOverdue: 1))
}
