import XCTest

final class MatrixTests: XCTestCase {
  override func setUp() { super.setUp(); continueAfterFailure = false }
  @MainActor
  func openWork(_ app: XCUIApplication) {
    let work = app.buttons["Work"].firstMatch
    if work.exists { work.click() }
    else { app.buttons["doc.text.below.ecg"].firstMatch.click() }
  }
  @MainActor
  func launchFixture(_ mode: String) async throws -> XCUIApplication {
    var request = URLRequest(url: URL(string: "http://127.0.0.1:31994/__fixture?mode=\(mode)")!)
    request.httpMethod = "POST"
    let (_, response) = try await URLSession.shared.data(for: request)
    XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
    let app = XCUIApplication()
    app.launchArguments = ["autopod://connect?url=http%3A%2F%2F127.0.0.1%3A31994%2Fsession%2F\(UUID().uuidString)&name=Acceptance%20Matrix&token=nonsecret-fixture"]
    app.launch()
    app.activate()
    var ready = false
    defer { if !ready { app.terminate() } }
    XCTAssertTrue(app.staticTexts["127.0.0.1:31994"].waitForExistence(timeout:20))
    if app.staticTexts["Connect to Daemon"].exists { app.buttons["Cancel"].click() }
    guard app.staticTexts["local-fixture"].firstMatch.waitForExistence(timeout:20) else {
      print("FIXTURE_SETUP_FAILURE\n" + app.windows.firstMatch.debugDescription)
      throw NSError(domain:"NativeFixture",code:1)
    }
    if app.staticTexts["Connect to Daemon"].exists { app.buttons["Cancel"].click() }
    let window=app.windows.firstMatch
    if window.frame.minX < 0 {
      let source=window.coordinate(withNormalizedOffset:CGVector(dx:0.5,dy:0)).withOffset(CGVector(dx:0,dy:16))
      let target=window.coordinate(withNormalizedOffset:CGVector(dx:0,dy:0)).withOffset(CGVector(dx:680-window.frame.minX,dy:358-window.frame.minY))
      source.press(forDuration:0.5,thenDragTo:target)
    }
    app.staticTexts["Browse"].firstMatch.click()
    let search=app.textFields["Search pods"]
    if search.exists, let value=search.value as? String, !value.isEmpty {
      let clear=app.windows.firstMatch.buttons.matching(identifier:"Close").allElementsBoundByIndex.min(by: { abs($0.frame.midY-search.frame.midY) < abs($1.frame.midY-search.frame.midY) })
      clear?.click()
    }
    guard app.staticTexts.matching(identifier: "local-fixture").element(boundBy:1).waitForExistence(timeout:10) else {
      print("FIXTURE_BROWSE_FAILURE\n" + app.windows.firstMatch.debugDescription)
      throw NSError(domain:"NativeFixture",code:2)
    }
    app.staticTexts.matching(identifier: "local-fixture").element(boundBy:1).click()
    guard app.buttons.matching(NSPredicate(format:"label IN %@", ["Work","doc.text.below.ecg"])).firstMatch.waitForExistence(timeout:10) else { throw NSError(domain:"NativeFixture",code:3) }
    ready = true
    return app
  }
  @MainActor
  func testCostTree() async throws {
    let app = try await launchFixture("duration-evidence")
    defer { app.terminate() }
    print("MATRIX_DETAIL_BEGIN\n" + app.windows.firstMatch.debugDescription + "\nMATRIX_DETAIL_END")
    openWork(app)
    let cost = app.buttons["Cost"].firstMatch
    XCTAssertTrue(cost.waitForExistence(timeout:10))
    cost.click()
    XCTAssertTrue(app.staticTexts["Worker execution"].waitForExistence(timeout:10))
    let coverage = app.staticTexts.matching(NSPredicate(format:"value CONTAINS %@", "1 records without duration"))
    XCTAssertTrue(coverage.firstMatch.exists)
    XCTAssertTrue(app.staticTexts.matching(NSPredicate(format:"value CONTAINS %@", "Stage durations can overlap; do not add them")).firstMatch.exists)
    app.staticTexts["Worker execution"].click()
    let image = XCTAttachment(screenshot: app.windows.firstMatch.screenshot())
    image.name = "native-worker-duration-coverage"; image.lifetime = .keepAlways; add(image)
    print("MATRIX_COST_BEGIN\n" + app.windows.firstMatch.debugDescription + "\nMATRIX_COST_END")
  }
  @MainActor
  func testDetailGuidanceDisclosure() async throws {
    let app = try await launchFixture("guidance-receipt")
    defer { app.terminate() }
    let nudges = app.windows.firstMatch.buttons.matching(identifier: "Nudge")
    XCTAssertTrue(nudges.firstMatch.waitForExistence(timeout:10))
    nudges.allElementsBoundByIndex.max(by: { $0.frame.minX < $1.frame.minX })!.click()
    XCTAssertTrue(app.staticTexts["Nudge agent"].waitForExistence(timeout:5))
    let pending = app.staticTexts.matching(NSPredicate(format:"value CONTAINS[c] %@", "pending until the worker acknowledges receipt"))
    let image = XCTAttachment(screenshot: app.windows.firstMatch.screenshot())
    image.name = "native-detail-guidance-disclosure"
    image.lifetime = .keepAlways
    add(image)
    XCTAssertTrue(pending.firstMatch.exists, "Detail guidance must explain that saving does not prove worker receipt")
    app.buttons["Cancel"].firstMatch.click()
  }
  @MainActor
  func testIntentionalRerunRetainsRequest() async throws {
    let app = try await launchFixture("dispatch")
    defer { app.terminate() }
    openWork(app)
    let field = app.textFields["Reason for intentional rerun"]
    XCTAssertTrue(field.waitForExistence(timeout:10))
    let scroller = app.windows.firstMatch.scrollViews.allElementsBoundByIndex.max(by: { $0.frame.minX < $1.frame.minX })!
    scroller.scroll(byDeltaX:0, deltaY:-1200)
    print("MATRIX_RERUN_BEGIN\n" + app.windows.firstMatch.debugDescription + "\nMATRIX_RERUN_END")
    XCTAssertFalse(app.buttons["Create intentional rerun"].isEnabled)
    field.click()
    field.typeText("Verify the corrected environment with the same contract")
    app.buttons["Create intentional rerun"].click()
    let retry = app.buttons["Retry the same rerun request"]
    XCTAssertTrue(retry.waitForExistence(timeout:10))
    XCTAssertFalse(field.isEnabled)
    retry.click()
    let created = app.staticTexts.matching(NSPredicate(format:"value CONTAINS %@", "Distinct execution created: same-fixture-rerun"))
    XCTAssertTrue(created.firstMatch.waitForExistence(timeout:10))
    XCTAssertFalse(app.staticTexts.matching(NSPredicate(format:"value CONTAINS %@", "Response unavailable after recording the simulated rerun")).firstMatch.exists, "A successful retry must clear the previous request error")
    let image = XCTAttachment(screenshot: app.windows.firstMatch.screenshot())
    image.name = "native-idempotent-rerun"
    image.lifetime = .keepAlways
    add(image)
  }

  @MainActor
  func testValidationRetryAuthorization() async throws {
    let app = try await launchFixture("retry")
    defer { app.terminate() }
    openWork(app)
    app.buttons["Cost"].click()
    let resume = app.buttons["Resume validation"]
    XCTAssertTrue(resume.waitForExistence(timeout:10))
    resume.click()
    XCTAssertTrue(app.staticTexts.matching(NSPredicate(format:"value CONTAINS %@", "Task-wide retry budget exhausted")).firstMatch.waitForExistence(timeout:10))
    let reason = app.textFields["Reason for one extra retry"]
    reason.click(); reason.typeText("Reconciled the retained validation environment")
    app.buttons["Record one retry authorization"].click()
    XCTAssertTrue(app.staticTexts.matching(NSPredicate(format:"value CONTAINS %@", "One retry authorization recorded")).firstMatch.waitForExistence(timeout:10))
    resume.click()
    XCTAssertTrue(app.staticTexts.matching(NSPredicate(format:"value CONTAINS %@", "Consumed: Reconciled")).firstMatch.waitForExistence(timeout:10))
    let image = XCTAttachment(screenshot:app.windows.firstMatch.screenshot())
    image.name="native-validation-authorization-consumed";image.lifetime = .keepAlways;add(image)
  }
  @MainActor
  func testScanSelectionBoundary() async throws {
    let app = try await launchFixture("dispatch")
    defer { app.terminate() }
    app.staticTexts["Scheduled Jobs"].firstMatch.click()
    let job = app.staticTexts["Local dependency and secret scan"].firstMatch
    guard job.waitForExistence(timeout:10) else { XCTFail("Fixture job missing");return }
    job.rightClick()
    app.menuItems["Reports and scan policy"].click()
    XCTAssertTrue(app.staticTexts["Report completion is separate from patch delivery."].waitForExistence(timeout:10))
    XCTAssertTrue(app.staticTexts["incomplete"].firstMatch.exists)
    XCTAssertFalse(app.buttons["Record repair selection"].isEnabled)
    XCTAssertFalse(app.buttons["Launch selected repair"].exists)
    let exact=app.disclosureTriangles["Exact source and files"]
    print("SCAN_DISCLOSURE_FRAME",exact.frame)
    print("SCAN_WINDOW_TREE\n" + app.windows.firstMatch.debugDescription)
    let before = XCTAttachment(screenshot:app.windows.firstMatch.screenshot())
    before.name="native-scan-before-input";before.lifetime = .keepAlways;add(before)
    var expanded=false
    for x:CGFloat in [-24,-16,-8,0,8,16] {
      exact.coordinate(withNormalizedOffset:CGVector(dx:0,dy:0.5)).withOffset(CGVector(dx:x,dy:0)).click()
      print("SCAN_DISCLOSURE_TARGET",x,exact.value ?? "nil")
      if app.staticTexts["modified: packages/example/package-lock.json"].waitForExistence(timeout:1) { expanded=true;break }
    }
    guard expanded else { XCTFail("Exact source did not expand");return }
    let choice=app.checkBoxes.matching(NSPredicate(format:"label CONTAINS %@", "fixture-finding-stable-identity")).firstMatch
    choice.coordinate(withNormalizedOffset:CGVector(dx:0,dy:0)).withOffset(CGVector(dx:8,dy:8)).click()
    let reason = app.textFields["Reason for the decision"]
    reason.click(); reason.typeText("Repair only the selected dependency finding")
    app.buttons["Record repair selection"].click()
    XCTAssertTrue(app.buttons["Launch selected repair"].waitForExistence(timeout:10))
    XCTAssertTrue(app.staticTexts["Includes earlier unresolved findings. A repair selection does not mark them fixed."].exists)
    app.buttons["Launch selected repair"].click()
    XCTAssertTrue(app.staticTexts["Repair pod: local-fixture · dispatch receipt"].waitForExistence(timeout:10))
    print("MATRIX_SCAN_BEGIN\n" + app.windows.firstMatch.debugDescription + "\nMATRIX_SCAN_END")
    let image = XCTAttachment(screenshot:app.windows.firstMatch.screenshot())
    image.name="native-scan-human-selected-repair";image.lifetime = .keepAlways;add(image)
  }

  @MainActor
  func testScanControls() async throws {
    let app = try await launchFixture("dispatch")
    defer { app.terminate() }
    app.staticTexts["Scheduled Jobs"].firstMatch.click()
    let job=app.staticTexts["Local dependency and secret scan"].firstMatch
    guard job.waitForExistence(timeout:10) else { XCTFail("Fixture job missing"); return }
    job.rightClick(); app.menuItems["Reports and scan policy"].click()
    guard app.staticTexts["Report completion is separate from patch delivery."].waitForExistence(timeout:10) else { XCTFail("Report missing"); return }
    let policy=app.disclosureTriangles["Report-only scan policy"]
    policy.coordinate(withNormalizedOffset:CGVector(dx:0,dy:0.5)).withOffset(CGVector(dx:-8,dy:0)).click()
    print("POLICY_EXPANDED",policy.value ?? "nil")
    if app.textFields["Base branch"].waitForExistence(timeout:3) { policy.click() }
    let exact=app.disclosureTriangles["Exact source and files"]
    exact.coordinate(withNormalizedOffset:CGVector(dx:0,dy:0.5)).withOffset(CGVector(dx:-8,dy:0)).click()
    print("EXACT_EXPANDED",exact.value ?? "nil")
    let image=XCTAttachment(screenshot:app.windows.firstMatch.screenshot())
    image.name="native-scan-controls";image.lifetime = .keepAlways;add(image)
    guard app.staticTexts["modified: packages/example/package-lock.json"].waitForExistence(timeout:3) else { XCTFail("Exact file disclosure did not expand"); return }
  }

}
