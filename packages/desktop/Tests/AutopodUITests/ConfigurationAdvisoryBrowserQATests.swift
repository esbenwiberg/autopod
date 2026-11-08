import AutopodClient
import Foundation
import Testing
@testable import AutopodUI

struct ConfigurationAdvisoryBrowserQATests {
  @Test(arguments: [false, true], [false, true])
  func legacyCombinations(phase: Bool, flag: Bool) throws {
    var payload: [String: ConfigurationJSON] = [
      "validationPhases": .array(phase ? [.string("test"), .string("advisory")] : [.string("test")]),
      "advisoryBrowserQaEnabled": .bool(flag), "future": .object(["keep": .null]),
    ]
    let original = payload
    #expect(ConfigurationAdvisoryBrowserQA.isEnabled(payload) == (phase && flag))
    #expect(payload == original)
    for enabled in [true, true, false, false, true] {
      ConfigurationAdvisoryBrowserQA.setEnabled(enabled, in: &payload)
      #expect(ConfigurationAdvisoryBrowserQA.isEnabled(payload) == enabled)
      #expect(payload["advisoryBrowserQaEnabled"] == .bool(enabled))
      #expect(payload["validationPhases"] == .array(enabled ? [.string("test"), .string("advisory")] : [.string("test")]))
      #expect(payload["future"] == original["future"])
      let persisted = try JSONDecoder().decode(ConfigurationJSON.self, from: Data(ConfigurationJSON.object(payload).formatted().utf8))
      #expect(persisted.object == payload)
      #expect(ConfigurationAdvisoryBrowserQA.isEnabled(try #require(persisted.object)) == enabled)
    }
  }

  @Test func missingFieldsStayDisabledUntilEdited() {
    let originals: [[String: ConfigurationJSON]] = [
      [:], ["advisoryBrowserQaEnabled": .bool(true)],
      ["validationPhases": .array([.string("advisory")])],
      ["validationPhases": .null, "advisoryBrowserQaEnabled": .null],
    ]
    for original in originals {
      var payload = original
      #expect(!ConfigurationAdvisoryBrowserQA.isEnabled(payload))
      #expect(payload == original)
      ConfigurationAdvisoryBrowserQA.setEnabled(false, in: &payload)
      #expect(payload["validationPhases"] == .array([]))
      #expect(payload["advisoryBrowserQaEnabled"] == .bool(false))
      ConfigurationAdvisoryBrowserQA.setEnabled(true, in: &payload)
      #expect(ConfigurationAdvisoryBrowserQA.isEnabled(payload))
      #expect(payload["validationPhases"] == .array([.string("advisory")]))
    }
  }

  @Test func duplicatesAreRemovedWithoutReorderingOtherValues() {
    let others: [ConfigurationJSON] = [.string("review"), .string("future-phase"), .string("test"), .string("test")]
    var payload: [String: ConfigurationJSON] = [
      "validationPhases": .array([others[0], .string("advisory"), others[1], .string("advisory"), others[2], others[3]]),
      "future": .array([.null, .number(42)]),
    ]
    ConfigurationAdvisoryBrowserQA.setEnabled(true, in: &payload)
    #expect(payload["validationPhases"] == .array([others[0], .string("advisory"), others[1], others[2], others[3]]))
    ConfigurationAdvisoryBrowserQA.setEnabled(false, in: &payload)
    #expect(payload["validationPhases"] == .array(others))
    #expect(payload["future"] == .array([.null, .number(42)]))
  }
}
