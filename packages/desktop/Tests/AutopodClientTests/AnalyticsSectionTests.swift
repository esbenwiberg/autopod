import Testing
@testable import AutopodUI

// MARK: - AnalyticsSection

@Test func analyticsSectionAllCasesOrder() {
    let cases = AnalyticsSection.allCases
    #expect(cases.count == 7)
    #expect(cases[0] == .overview)
    #expect(cases[1] == .cost)
    #expect(cases[2] == .reliability)
    #expect(cases[3] == .quality)
    #expect(cases[4] == .safety)
    #expect(cases[5] == .throughput)
    #expect(cases[6] == .models)
}

@Test func analyticsSectionOverviewIsShipped() {
    #expect(AnalyticsSection.overview.isShipped == true)
}

@Test func analyticsSectionNonOverviewNotShipped() {
    let unshipped: [AnalyticsSection] = [.cost, .reliability, .quality, .safety, .throughput, .models]
    for section in unshipped {
        #expect(section.isShipped == false, "Expected \(section) to be unshipped")
    }
}

// MARK: - SidebarItem

@Test func sidebarItemAnalyticsSectionHashableEquality() {
    let a = SidebarItem.analyticsSection(.overview)
    let b = SidebarItem.analyticsSection(.overview)
    #expect(a == b)
}

@Test func sidebarItemAnalyticsSectionInequalityAcrossSections() {
    #expect(SidebarItem.analyticsSection(.overview) != SidebarItem.analyticsSection(.cost))
}

// MARK: - MainView.filterPods

@Test func filterPodsReturnsEmptyForAllAnalyticsSections() {
    let pods: [Pod] = []
    for section in AnalyticsSection.allCases {
        let result = MainView.filterPods(pods, for: .analyticsSection(section))
        #expect(result.isEmpty, "Expected empty result for analyticsSection(.\(section))")
    }
}
