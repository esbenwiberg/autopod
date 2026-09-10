import XCTest

// Pending interaction acceptance: these cases are deliberately opt-in.
extension MatrixTests {
  @MainActor
  func testRecordedDeliveryRefreshKeepsProviderUnverified() async throws {
    let app=try await launchFixture("delivery-disposition");defer { app.terminate() }
    openWork(app);app.buttons["Cost"].click()
    guard visibleText(app,"PR disposition observations unavailable").waitForExistence(timeout:5) else { XCTFail("Initial unavailable state missing");return }
    openDetailTab(app,"Overview","square.text.square")
    openWork(app);app.buttons["Cost"].click()
    guard visibleText(app,"Last recorded PR status: 0 open · 1 merged · 0 closed · 0 unavailable").waitForExistence(timeout:5) else { print("DELIVERY_REFRESH_WINDOW\n"+app.windows.firstMatch.debugDescription);XCTFail("Recorded merge observation missing");return }
    XCTAssertTrue(visibleText(app,"Current provider status unverified").exists)
    XCTAssertTrue(visibleText(app,"1 PR receipts · 1 unresolved of 2 intents").exists)
    app.staticTexts["Task accounting"].click()
    let image=XCTAttachment(screenshot:app.windows.firstMatch.screenshot());image.name="native-recorded-delivery-refresh";image.lifetime = .keepAlways;add(image)
  }
  @MainActor
  func testRestartOwnershipHintPreservesRunningState() async throws {
    let app=try await launchFixture("reconciliation-ownership");defer { app.terminate() }
    openDetailTab(app,"Overview","square.text.square")
    XCTAssertTrue(visibleText(app,"Recovery paused: task execution or cleanup ownership remains unresolved").waitForExistence(timeout:5))
    XCTAssertTrue(app.staticTexts["running"].firstMatch.exists)
    print("RESTART_OWNERSHIP_WINDOW\n"+app.windows.firstMatch.debugDescription)
    let image=XCTAttachment(screenshot:app.windows.firstMatch.screenshot());image.name="native-restart-ownership-hint";image.lifetime = .keepAlways;add(image)
  }
  @MainActor
  func testUnavailableReviewRetainsBindingReason() async throws {
    let app=try await launchFixture("foundry-review-unavailable");defer { app.terminate() }
    openDetailTab(app,"Validation","checkmark.seal")
    print("UNAVAILABLE_REVIEW_WINDOW\n"+app.windows.firstMatch.debugDescription)
    let review=app.buttons.matching(NSPredicate(format:"label BEGINSWITH %@", "Review,")).firstMatch
    guard review.waitForExistence(timeout:5) else { XCTFail("Review phase missing");return }
    review.click()
    XCTAssertTrue(visibleText(app,"Foundry tool review unavailable on the selected provider binding").waitForExistence(timeout:5))
    let image=XCTAttachment(screenshot:app.windows.firstMatch.screenshot());image.name="native-unavailable-review-binding";image.lifetime = .keepAlways;add(image)
  }
}
