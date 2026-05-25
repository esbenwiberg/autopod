import Foundation
import Testing
@testable import AutopodClient
@testable import AutopodDesktop
import AutopodUI

@Test func profileResponseDecodesAdvisoryBrowserQaNil() throws {
  let profile = try decodeProfile(advisoryBrowserQaFragment: "")

  #expect(profile.pod?.advisoryBrowserQaEnabled == nil)
  #expect(ProfileMapper.map(profile).pod.advisoryBrowserQaEnabled == nil)
}

@Test func profileResponseDecodesAdvisoryBrowserQaTrue() throws {
  let profile = try decodeProfile(advisoryBrowserQaFragment: #","advisoryBrowserQaEnabled": true"#)

  #expect(profile.pod?.advisoryBrowserQaEnabled == true)
  #expect(ProfileMapper.map(profile).pod.advisoryBrowserQaEnabled == true)
}

@Test func profileResponseDecodesAdvisoryBrowserQaFalse() throws {
  let profile = try decodeProfile(advisoryBrowserQaFragment: #","advisoryBrowserQaEnabled": false"#)

  #expect(profile.pod?.advisoryBrowserQaEnabled == false)
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

private func decodeProfile(advisoryBrowserQaFragment: String) throws -> ProfileResponse {
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
