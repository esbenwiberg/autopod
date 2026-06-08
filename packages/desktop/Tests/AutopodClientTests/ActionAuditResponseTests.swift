import Foundation
import Testing
@testable import AutopodClient

@Test func actionAuditResponseDecodesRowsAndValidChain() throws {
    let json = """
    {
      "rows": [
        {
          "id": 42,
          "podId": "prior-loon",
          "actionName": "azure.deploy",
          "params": { "app": "guardian", "slot": "staging" },
          "responseSummary": "Deployment accepted.",
          "piiDetected": true,
          "quarantineScore": 0.2,
          "piiCategories": ["email", "phone"],
          "createdAt": "2026-06-08 14:07:21",
          "prevHash": null,
          "entryHash": "abcdef"
        }
      ],
      "chain": {
        "valid": true,
        "rowCount": 1,
        "firstBadId": null,
        "reason": null
      }
    }
    """.data(using: .utf8)!

    let response = try JSONDecoder().decode(ActionAuditResponse.self, from: json)

    #expect(response.rows.count == 1)
    #expect(response.rows[0].id == 42)
    #expect(response.rows[0].actionName == "azure.deploy")
    #expect(response.rows[0].params["app"]?.stringValue == "guardian")
    #expect(response.rows[0].piiDetected == true)
    #expect(response.rows[0].piiCategories == ["email", "phone"])
    #expect(response.chain.valid == true)
    #expect(response.chain.rowCount == 1)
}

@Test func actionAuditResponseDecodesNullCategoriesAndInvalidChain() throws {
    let json = """
    {
      "rows": [
        {
          "id": 7,
          "podId": "prior-loon",
          "actionName": "github.comment",
          "params": {},
          "responseSummary": null,
          "piiDetected": false,
          "quarantineScore": 0,
          "piiCategories": null,
          "createdAt": "2026-06-08 14:07:21",
          "prevHash": "prev",
          "entryHash": "bad"
        }
      ],
      "chain": {
        "valid": false,
        "rowCount": 1,
        "firstBadId": 7,
        "reason": "entry_hash mismatch for row id=7"
      }
    }
    """.data(using: .utf8)!

    let response = try JSONDecoder().decode(ActionAuditResponse.self, from: json)

    #expect(response.rows[0].piiCategories == nil)
    #expect(response.rows[0].responseSummary == nil)
    #expect(response.chain.valid == false)
    #expect(response.chain.firstBadId == 7)
    #expect(response.chain.reason == "entry_hash mismatch for row id=7")
}
