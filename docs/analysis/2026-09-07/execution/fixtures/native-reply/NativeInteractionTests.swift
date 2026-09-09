import XCTest

final class NativeInteractionTests: XCTestCase {
  @MainActor
  func testNativeInteractionFacility() {
    let app = XCUIApplication()
    app.launch()
    defer { app.terminate() }
    XCTAssertTrue(app.staticTexts["Connect to Daemon"].waitForExistence(timeout: 20))
    let name = app.textFields["Local"]
    XCTAssertTrue(name.waitForExistence(timeout: 5))
    name.click()
    name.typeKey("a", modifierFlags: .command)
    name.typeText("Local acceptance fixture")
    XCTAssertEqual(name.value as? String, "Local acceptance fixture")
    let image = XCTAttachment(screenshot: app.windows.firstMatch.screenshot())
    image.name = "native-setup-typed-value"
    image.lifetime = .keepAlways
    add(image)
  }
  @MainActor
  func testConnectedFixtureTree() {
    let app = XCUIApplication()
    app.launchArguments = ["autopod://connect?url=http%3A%2F%2F127.0.0.1%3A31992&name=Acceptance%20Fixture&token=nonsecret-fixture"]
    app.launch()
    defer { app.terminate() }
    XCTAssertTrue(app.windows.firstMatch.waitForExistence(timeout: 20))
    let pod = app.buttons["Reply"].firstMatch
    XCTAssertTrue(pod.waitForExistence(timeout: 20))
    if app.windows.firstMatch.buttons["OK"].exists { app.windows.firstMatch.buttons["OK"].click() }
    if app.staticTexts["Connect to Daemon"].exists { app.buttons["Cancel"].click() }
    app.staticTexts.matching(identifier: "local-fixture").element(boundBy: 1).click()
    _ = app.staticTexts["Which finding should be repaired?"].waitForExistence(timeout: 10)
    print("AUTOPOD_FIXTURE_TREE_BEGIN\n" + app.windows.firstMatch.debugDescription + "\nAUTOPOD_FIXTURE_TREE_END")
    let image = XCTAttachment(screenshot: app.windows.firstMatch.screenshot())
    image.name = "native-connected-fixture-window"
    image.lifetime = .keepAlways
    add(image)
    XCTAssertTrue(pod.exists)
  }
  @MainActor
  func testFailedReplyRetainsDecision() {
    let app = XCUIApplication()
    app.launchArguments = ["autopod://connect?url=http%3A%2F%2F127.0.0.1%3A31992&name=Acceptance%20Fixture&token=nonsecret-fixture"]
    app.launch()
    defer { app.terminate() }
    XCTAssertTrue(app.buttons["Reply"].firstMatch.waitForExistence(timeout: 20))
    if app.staticTexts["Connect to Daemon"].exists { app.buttons["Cancel"].click() }
    app.staticTexts.matching(identifier: "local-fixture").element(boundBy: 1).click()
    let decision = app.buttons["Keep report only"]
    XCTAssertTrue(decision.waitForExistence(timeout: 10))
    decision.click()
    XCTAssertTrue(app.windows.firstMatch.buttons["OK"].firstMatch.waitForExistence(timeout: 10))
    for _ in 0..<3 {
      let ok = app.windows.firstMatch.buttons["OK"].firstMatch
      if ok.exists { ok.click() }
    }
    let image = XCTAttachment(screenshot: app.windows.firstMatch.screenshot())
    image.name = "native-failed-reply-decision-state"
    image.lifetime = .keepAlways
    add(image)
    XCTAssertTrue(decision.exists, "A failed reply must leave the unanswered decision actionable")
    XCTAssertTrue(app.staticTexts["awaiting input"].firstMatch.exists, "A failed reply must not claim the worker is running")
  }
}
