import AutopodClient
import Testing
@testable import AutopodUI

@Test func node24PostgresTemplateRetainsItsIdentity() {
  let template = StackTemplate(rawValue: "node24-pw-pg")
  #expect(template == .node24PwPg)
  #expect(template?.rawValue == "node24-pw-pg")
  #expect(template?.label == "Node 24 + Playwright + PostgreSQL 17")
  #expect(StackTemplate.allCases.contains(.node24PwPg))
  #expect(StackTemplate(rawValue: "node22-pw-pg") == .node22PwPg)
}

@Test func newNodeProfilesDefaultToNode24() {
  #expect(Profile(name: "new", repoUrl: "").template == .node24)
  #expect(ProfileResponse().template == "node24")
}
