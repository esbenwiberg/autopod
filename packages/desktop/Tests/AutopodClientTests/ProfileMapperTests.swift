import Foundation
import Testing
@testable import AutopodClient
@testable import AutopodDesktop
import AutopodUI

@Test func profileMapperMapsNilAdvisoryBrowserQa() throws {
  let profile = try decodeMapperProfile(advisoryBrowserQaFragment: "")

  #expect(ProfileMapper.map(profile).pod.advisoryBrowserQaEnabled == nil)
}

@Test func profileMapperMapsTrueAdvisoryBrowserQa() throws {
  let profile = try decodeMapperProfile(
    advisoryBrowserQaFragment: #","advisoryBrowserQaEnabled": true"#
  )

  #expect(ProfileMapper.map(profile).pod.advisoryBrowserQaEnabled == true)
}

@Test func profileMapperMapsFalseAdvisoryBrowserQa() throws {
  let profile = try decodeMapperProfile(
    advisoryBrowserQaFragment: #","advisoryBrowserQaEnabled": false"#
  )

  #expect(ProfileMapper.map(profile).pod.advisoryBrowserQaEnabled == false)
}

@Test func profilePatchOmitsNilAdvisoryBrowserQa() {
  let profile = Profile(
    name: "app",
    repoUrl: "https://github.com/org/app.git",
    pod: PodConfig(advisoryBrowserQaEnabled: nil)
  )

  let pod = ProfileMapper.mapToFields(profile)["pod"] as? [String: Any]
  #expect(pod?["advisoryBrowserQaEnabled"] == nil)
}

@Test func profilePatchIncludesTrueAdvisoryBrowserQa() {
  let profile = Profile(
    name: "app",
    repoUrl: "https://github.com/org/app.git",
    pod: PodConfig(advisoryBrowserQaEnabled: true)
  )

  let pod = ProfileMapper.mapToFields(profile)["pod"] as? [String: Any]
  #expect(pod?["advisoryBrowserQaEnabled"] as? Bool == true)
}

@Test func profilePatchIncludesFalseAdvisoryBrowserQa() {
  let profile = Profile(
    name: "app",
    repoUrl: "https://github.com/org/app.git",
    pod: PodConfig(advisoryBrowserQaEnabled: false)
  )

  let pod = ProfileMapper.mapToFields(profile)["pod"] as? [String: Any]
  #expect(pod?["advisoryBrowserQaEnabled"] as? Bool == false)
}

private func decodeMapperProfile(advisoryBrowserQaFragment: String) throws -> ProfileResponse {
  let json = """
  {
    "name": "app",
    "pod": {
      "agentMode": "auto",
      "output": "pr",
      "validate": true\(advisoryBrowserQaFragment),
      "promotable": false
    },
    "version": 1,
    "createdAt": "2026-05-25T00:00:00Z",
    "updatedAt": "2026-05-25T00:00:00Z"
  }
  """.data(using: .utf8)!

  return try JSONDecoder().decode(ProfileResponse.self, from: json)
}
