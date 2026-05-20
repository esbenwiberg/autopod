import Foundation
import Testing
@testable import AutopodUI

@Test func validationPageScreenshotPrefersInlinePageScreenshot() {
    let inline = ScreenshotRef(
        url: URL(string: "http://127.0.0.1:3100/inline.png")!,
        source: .smoke,
        label: "/"
    )
    let fallback = ScreenshotRef(
        url: URL(string: "http://127.0.0.1:3100/fallback.png")!,
        source: .smoke,
        label: "/"
    )
    let page = PageDetail(
        path: "/",
        status: "pass",
        consoleErrors: [],
        assertions: [],
        loadTime: 10,
        screenshot: inline
    )

    let resolved = validationPageScreenshot(page, proofOfWorkScreenshots: [fallback])

    #expect(resolved == inline)
}

@Test func validationPageScreenshotFallsBackToMatchingProofOfWorkSmokeShot() {
    let matching = ScreenshotRef(
        url: URL(string: "http://127.0.0.1:3100/root.png")!,
        source: .smoke,
        label: "/"
    )
    let wrongSource = ScreenshotRef(
        url: URL(string: "http://127.0.0.1:3100/ac.png")!,
        source: .ac,
        label: "/"
    )
    let wrongPath = ScreenshotRef(
        url: URL(string: "http://127.0.0.1:3100/about.png")!,
        source: .smoke,
        label: "/about"
    )
    let page = PageDetail(
        path: "/",
        status: "pass",
        consoleErrors: [],
        assertions: [],
        loadTime: 10
    )

    let resolved = validationPageScreenshot(
        page,
        proofOfWorkScreenshots: [wrongSource, wrongPath, matching]
    )

    #expect(resolved == matching)
}
