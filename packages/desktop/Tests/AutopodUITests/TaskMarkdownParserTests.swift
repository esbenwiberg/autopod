import Testing
@testable import AutopodUI

@Test func leadingTextBecomesTaskSection() {
    let document = TaskMarkdownParser.parse("""
    Add a read service over `IContentConfigurationService`.

    ## Constraints
    Use the existing persistence path.
    """)

    #expect(document.sections.count == 2)
    #expect(document.sections[0].title == "Task")
    #expect(document.sections[0].kind == .task)
    #expect(document.sections[0].body == "Add a read service over `IContentConfigurationService`.")
    #expect(document.sections[1].title == "Constraints")
    #expect(document.sections[1].kind == .constraints)
}

@Test func headingCapturesBodyUntilNextHeading() {
    let document = TaskMarkdownParser.parse("""
    # Task
    Build the service.

    ## Constraints
    Preserve selected behavior.

    - direct child selection
    - selected parent propagation

    ## Test expectations
    Add focused unit tests.
    """)

    #expect(document.sections.count == 3)
    #expect(document.sections[1].title == "Constraints")
    #expect(document.sections[1].body.contains("- direct child selection"))
    #expect(document.sections[1].body.contains("- selected parent propagation"))
    #expect(document.sections[2].kind == .tests)
    #expect(document.usesStructuredCards == true)
}

@Test func unknownHeadingsRenderAsGenericSections() {
    let document = TaskMarkdownParser.parse("""
    ## Rollout notes
    Keep this behind the existing route.
    """)

    #expect(document.sections.count == 1)
    #expect(document.sections[0].title == "Rollout notes")
    #expect(document.sections[0].kind == .generic)
    #expect(document.usesStructuredCards == true)
}

@Test func bulletsAndInlineCodeArePreserved() {
    let document = TaskMarkdownParser.parse("""
    ## DTOs
    - `WorkPackageListItemDto`
    - `WorkPackageTreeItemDto(Guid Id, string Name)`
    """)

    #expect(document.sections.count == 1)
    #expect(document.sections[0].body == """
    - `WorkPackageListItemDto`
    - `WorkPackageTreeItemDto(Guid Id, string Name)`
    """)
}

@Test func whitespaceOnlySectionsAreIgnored() {
    let document = TaskMarkdownParser.parse("""
    ## Empty

    ## Does not touch:
    No frontend changes.
    """)

    #expect(document.sections.count == 1)
    #expect(document.sections[0].title == "Does not touch:")
    #expect(document.sections[0].kind == .excluded)
}

@Test func headingsInsideCodeFencesAreNotParsed() {
    let document = TaskMarkdownParser.parse("""
    ## Task
    Keep the example intact.

    ```md
    ## Not a section
    body
    ```
    """)

    #expect(document.sections.count == 1)
    #expect(document.sections[0].body.contains("## Not a section"))
}

@Test func plainMarkdownKeepsLegacySingleSectionBehavior() {
    let document = TaskMarkdownParser.parse("Add a small endpoint and tests.")

    #expect(document.sections.count == 1)
    #expect(document.sections[0].title == "Task")
    #expect(document.usesStructuredCards == false)
}
