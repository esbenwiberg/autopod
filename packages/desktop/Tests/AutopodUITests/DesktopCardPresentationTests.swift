import AppKit
import AutopodClient
import Foundation
import SwiftUI
import Testing
@testable import AutopodUI

private func cardPod(status: PodStatus = .mergePending) -> Pod {
    Pod(id: "card-fixture", status: status, branch: "fix/card", profileName: "78043925-8fb4-4e81-8aba-19b6666a6896",
        task: "Fix Sentry group rc-0d8a7060 (null_guard)", model: "claude-opus-5-5",
        startedAt: Date(timeIntervalSince1970: 0),
        prUrl: URL(string: "https://dev.azure.com/org/project/_git/PowerGantt/pullrequest/15124"),
        costUsd: 0.65,
        fleetDisplay: .init(repository: .init(kind: "repository", remote: "https://dev.azure.com/365projectum/Projects/_git/PowerGantt"),
                            activeTime: .init(elapsedMs: 720_000)))
}

@Test func cardRepositoryBasenamesDoNotChangeIdentity() throws {
    for remote in ["https://github.com/context-and-sandbox/agent-pods-platform.git",
                   "git@github.com:context-and-sandbox/agent-pods-platform.git"] {
        let repository = try #require(DesktopRepository(url: remote))
        #expect(repository.name == "agent-pods-platform")
        #expect(repository.label == "context-and-sandbox/agent-pods-platform")
    }
    let azure = try #require(DesktopRepository(url: "https://user:secret@dev.azure.com/org/project/_git/PowerGantt?token=secret"))
    #expect(azure.name == "PowerGantt")
    #expect(azure.label == "org/project/PowerGantt")
    #expect(!azure.id.contains("secret"))
}

@Test func cardMetadataHidesOpaqueProfileIdentifiersButRetainsHumanNames() {
    var pod = cardPod()
    #expect(pod.desktopCardMetadata == "claude-opus-5-5")
    pod.profileName = "profile-56ed8b498a38c3a703ca18fb"
    #expect(pod.desktopCardMetadata == "claude-opus-5-5")
    pod.profileName = "Autopod development"
    #expect(pod.desktopCardMetadata == "Autopod development · claude-opus-5-5")
    pod.profileName = "  "
    #expect(pod.desktopCardMetadata == "claude-opus-5-5")
}

@Test func activeCardTimeFreezesWhileWaitingAndAfterCompletion() {
    var pod = cardPod()
    for status in [PodStatus.paused, .awaitingInput, .mergePending, .complete, .failed, .killed] {
        pod.status = status
        #expect(pod.desktopActiveDuration(at: .now) == "Active 12m")
        #expect(pod.desktopActiveDuration(at: Date().addingTimeInterval(86400)) == "Active 12m")
    }
    pod.fleetDisplay = .init(repository: .init(kind: "empty"))
    #expect(pod.desktopActiveDuration(at: .now) == "Active —")
}

@Test func activeCardTimeUsesOnlyRecordedIntervalsAndRejectsBadOrStaleEvidence() throws {
    var pod = cardPod(status: .running)
    let start = try Date("2026-11-01T12:00:00.000Z", strategy: Date.ISO8601FormatStyle(includingFractionalSeconds: true))
    func setTime(_ milliseconds: Double, since: String? = nil) {
        pod.fleetDisplay = .init(repository: .init(kind: "empty"),
                                activeTime: .init(elapsedMs: milliseconds, activeSince: since))
    }
    setTime(120_000, since: "2026-11-01T12:00:00.000Z")
    #expect(pod.desktopActiveDuration(at: start.addingTimeInterval(60)) == "Active 3m")
    pod.status = .complete // Status event arrived before the REST timing refresh.
    #expect(pod.desktopActiveDuration(at: start.addingTimeInterval(3600)) == "Active —")
    pod.status = .validating
    setTime(0, since: "2026-11-01T12:00:00Z")
    #expect(pod.desktopActiveDuration(at: start.addingTimeInterval(1)) == "Active <1m")
    setTime(0)
    #expect(pod.desktopActiveDuration(at: start) == "Active 0m")
    setTime(3_660_000)
    #expect(pod.desktopActiveDuration(at: start) == "Active 1h 1m")
    for invalid in [-1.0, .infinity, .nan, Double.greatestFiniteMagnitude] {
        setTime(invalid)
        #expect(pod.desktopActiveDuration(at: start) == "Active —")
    }
    setTime(0, since: "not-a-date")
    #expect(pod.desktopActiveDuration(at: start) == "Active —")
    setTime(0, since: "2099-01-01T00:00:00Z")
    #expect(pod.desktopActiveDuration(at: start) == "Active —")
}

@Test func fleetTimingDecodingIsBackwardCompatible() throws {
    let decoder = JSONDecoder()
    let old = try decoder.decode(PodFleetDisplayResponse.self, from: Data(#"{"repository":{"kind":"empty"}}"#.utf8))
    #expect(old.activeTime == nil)
    let current = try decoder.decode(PodFleetDisplayResponse.self, from: Data(#"{"repository":{"kind":"empty"},"activeTime":{"elapsedMs":1234,"activeSince":null}}"#.utf8))
    #expect(current.activeTime?.elapsedMs == 1234)
    #expect(current.activeTime?.activeSince == nil)
}

@MainActor @Test func desktopStatusTextHasContrastInBothAppearances() throws {
    func luminance(_ color: NSColor) -> Double {
        let rgb = color.usingColorSpace(.sRGB)!
        func linear(_ v: Double) -> Double { v <= 0.04045 ? v / 12.92 : pow((v + 0.055) / 1.055, 2.4) }
        return 0.2126 * linear(rgb.redComponent) + 0.7152 * linear(rgb.greenComponent) + 0.0722 * linear(rgb.blueComponent)
    }
    for name in [NSAppearance.Name.aqua, .darkAqua] {
        let appearance = try #require(NSAppearance(named: name))
        appearance.performAsCurrentDrawingAppearance {
            let surface = luminance(NSColor(DesktopTheme.surface))
            for status in PodStatus.allCases {
                let foreground = luminance(NSColor(DesktopTheme.statusColor(status)))
                let ratio = (max(surface, foreground) + 0.05) / (min(surface, foreground) + 0.05)
                #expect(ratio >= 4.5)
            }
            let complete = NSColor(DesktopTheme.statusColor(.complete)).usingColorSpace(.sRGB)
            let findings = NSColor(DesktopTheme.statusColor(.researchReady)).usingColorSpace(.sRGB)
            let attention = NSColor(DesktopTheme.statusColor(.reviewRequired)).usingColorSpace(.sRGB)
            #expect(complete != nil && findings != nil && attention != nil)
            #expect(NSColor(DesktopTheme.statusColor(.mergePending)).usingColorSpace(.sRGB) != complete)
            #expect(findings == attention)
            #expect(findings != complete)
        }
    }
}

@MainActor @Test func desktopCardRendersAtNarrowAndWideSizes() throws {
    NSApplication.shared.finishLaunching()
    let pod = cardPod()
    let repository = try #require(DesktopRepository.resolve(pod, profiles: []))
    for dark in [false, true] {
        for width in [250.0, 420.0] {
            let view = SessionCardFinal(pod: pod, density: width == 250 ? .compact : .detailed)
                .environment(\.desktopRedesign, true)
                .environment(\.desktopRepositories, [pod.id: repository])
                .environment(\.colorScheme, dark ? .dark : .light)
                .frame(width: width, height: 240)
                .padding(12).background(DesktopTheme.canvas)
            let hosting = NSHostingView(rootView: view)
            hosting.frame = NSRect(x: 0, y: 0, width: width + 24, height: 264)
            hosting.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
            hosting.layoutSubtreeIfNeeded()
            let bitmap = try #require(hosting.bitmapImageRepForCachingDisplay(in: hosting.bounds))
            hosting.cacheDisplay(in: hosting.bounds, to: bitmap)
            #expect(abs(bitmap.size.width - (width + 24)) < 0.5)
            if let directory = ProcessInfo.processInfo.environment["AUTOPOD_CARD_SNAPSHOTS"] {
                let output = URL(fileURLWithPath: directory, isDirectory: true)
                try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
                let png = try #require(bitmap.representation(using: .png, properties: [:]))
                try png.write(to: output.appendingPathComponent("card-\(dark ? "dark" : "light")-\(Int(width)).png"))
            }
        }
    }
}
