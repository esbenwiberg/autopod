import Testing
@testable import AutopodUI

@MainActor
@Test func sessionProcessHealthMapsUnavailableReasonsToNeutralText() {
    #expect(SessionQualityCard.unavailableReasonDescription("no_activity") == "No quality-relevant activity was retained for this session.")
    #expect(SessionQualityCard.unavailableReasonDescription("ambiguous_inspection") == "An inspection command could not be verified safely.")
    #expect(SessionQualityCard.unavailableReasonDescription("unresolved_write") == "Native write activity could not be resolved safely.")
    #expect(SessionQualityCard.unavailableReasonDescription("mixed_pi_runtime") == "Mixed Pi and non-Pi runtime evidence is unavailable.")
    #expect(SessionQualityCard.unavailableReasonDescription("historical_pi") == "Historical Pi activity does not retain compatible evidence.")
}
