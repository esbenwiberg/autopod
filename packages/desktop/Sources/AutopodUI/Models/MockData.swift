import Foundation

public enum MockData: Sendable {
    public static let all: [Session] = [
        awaitingInput, validated, validatedFailed, failed,
        running, runningEarly, validating,
        workspaceActive, workspaceComplete,
        workerFromWorkspace,
        queued, provisioning, merging, complete, killed,
    ]

    public static let awaitingInput = Session(
        status: .awaitingInput, branch: "feat/oauth", profileName: "my-app", model: "claude-opus",
        startedAt: .minutesAgo(5),
        diffStats: DiffStats(added: 34, removed: 8, files: 4),
        escalationQuestion: "Which OAuth provider should I use — Google, GitHub, or both?",
        latestActivity: "Paused at auth strategy decision"
    )

    public static let validated = Session(
        status: .validated, branch: "feat/cart", profileName: "webapp", model: "claude-opus",
        startedAt: .minutesAgo(12),
        diffStats: DiffStats(added: 142, removed: 38, files: 8),
        validationChecks: ValidationChecks(smoke: true, tests: true, review: true),
        containerUrl: URL(string: "http://localhost:3001")
    )

    public static let validatedFailed = Session(
        status: .validated, branch: "fix/auth-flow", profileName: "webapp", model: "claude-sonnet",
        startedAt: .minutesAgo(18),
        diffStats: DiffStats(added: 55, removed: 12, files: 5),
        validationChecks: ValidationChecks(
            smoke: false, tests: false, review: false,
            buildOutput: nil,
            testOutput: "FAIL src/auth/login.test.ts\n  ✕ should redirect after login (42ms)\n    Expected: 302\n    Received: 500",
            reviewIssues: ["Missing error handling in OAuth callback route", "SQL injection risk in user lookup query"],
            reviewReasoning: "The implementation has two medium-severity issues that should be addressed before merge.",
            healthCheck: HealthCheckDetail(status: "fail", url: "http://localhost:3000/health", responseCode: 502, duration: 3200),
            pages: [
                PageDetail(
                    path: "/login", status: "fail",
                    consoleErrors: ["TypeError: Cannot read property 'auth' of undefined"],
                    assertions: [
                        AssertionDetail(selector: "#login-form", type: "visible", expected: "visible", actual: "not found", passed: false),
                        AssertionDetail(selector: "#oauth-button", type: "exists", expected: nil, actual: nil, passed: false),
                    ],
                    loadTime: 4500
                ),
                PageDetail(
                    path: "/dashboard", status: "pass",
                    consoleErrors: [],
                    assertions: [AssertionDetail(selector: "#main-content", type: "visible", expected: nil, actual: nil, passed: true)],
                    loadTime: 800
                ),
            ],
            acValidation: false,
            acChecks: [
                AcCheckDetail(criterion: "Login form renders correctly", passed: false, reasoning: "Login form element not found — page returns 502", validationType: "web-ui"),
                AcCheckDetail(criterion: "OAuth tokens stored encrypted at rest", passed: true, reasoning: "Verified AES-256 encryption in storage layer", validationType: "none"),
            ],
            requirementsCheck: [
                RequirementCheckDetail(criterion: "OAuth callback handles errors", met: false, note: "No error handling in callback route"),
                RequirementCheckDetail(criterion: "Session middleware preserved", met: true, note: "Fully met"),
            ]
        ),
        attempts: AttemptInfo(current: 1, max: 3)
    )

    public static let failed = Session(
        status: .failed, branch: "fix/perf", profileName: "backend", model: "claude-opus",
        startedAt: .minutesAgo(11),
        diffStats: DiffStats(added: 22, removed: 5, files: 3),
        errorSummary: "Build failed — tsc exit 1",
        attempts: AttemptInfo(current: 2, max: 3)
    )

    public static let running = Session(
        status: .running, branch: "refactor/api", profileName: "backend", model: "claude-opus",
        startedAt: .minutesAgo(8),
        diffStats: DiffStats(added: 89, removed: 12, files: 5),
        plan: SessionPlan(
            summary: "Refactor API routes to use express-style middleware chain",
            steps: [
                "Extract auth middleware from inline handlers",
                "Create shared validation middleware",
                "Migrate user routes to new pattern",
                "Migrate admin routes to new pattern",
                "Add integration tests for middleware chain",
            ]
        ),
        phase: PhaseProgress(current: 8, total: 10, description: "Writing API tests"),
        latestActivity: "Modified routes/users.ts"
    )

    public static let runningEarly = Session(
        status: .running, branch: "feat/dashboard", profileName: "webapp", model: "claude-sonnet",
        startedAt: .minutesAgo(3),
        diffStats: DiffStats(added: 23, removed: 4, files: 3),
        phase: PhaseProgress(current: 3, total: 10, description: "Analyzing existing routes"),
        latestActivity: "Reading src/pages/index.tsx"
    )

    public static let validating = Session(
        status: .validating, branch: "fix/n+1", profileName: "backend", model: "claude-sonnet",
        startedAt: .minutesAgo(15),
        diffStats: DiffStats(added: 45, removed: 31, files: 6),
        containerUrl: URL(string: "http://localhost:3002"),
        attempts: AttemptInfo(current: 1, max: 3)
    )

    // MARK: - Workspace pods

    public static let workspaceActive = Session(
        status: .running, outputMode: .workspace, branch: "plan/auth-redesign",
        profileName: "my-app", model: "—",
        startedAt: .minutesAgo(25),
        diffStats: DiffStats(added: 15, removed: 0, files: 3),
        containerUrl: URL(string: "http://localhost:3003"),
        latestActivity: "Interactive — user attached"
    )

    public static let workspaceComplete = Session(
        status: .complete, outputMode: .workspace, branch: "plan/migrate-db",
        profileName: "backend", model: "—",
        startedAt: .minutesAgo(60),
        diffStats: DiffStats(added: 42, removed: 0, files: 5),
        latestActivity: "Branch pushed"
    )

    // Worker spawned from a workspace branch
    public static let workerFromWorkspace = Session(
        status: .running, outputMode: .pr, branch: "feat/auth-redesign",
        profileName: "my-app", model: "claude-opus",
        startedAt: .minutesAgo(6),
        baseBranch: "plan/auth-redesign",
        acFrom: "specs/auth-ac.md",
        acceptanceCriteria: [
            "Users can sign in with Google OAuth",
            "OAuth tokens are stored encrypted at rest",
            "Existing session middleware is preserved",
        ],
        diffStats: DiffStats(added: 56, removed: 8, files: 6),
        phase: PhaseProgress(current: 5, total: 10, description: "Implementing OAuth callback"),
        latestActivity: "Writing src/auth/google.ts"
    )

    // MARK: - Other states

    public static let queued = Session(
        status: .queued, branch: "feat/i18n", profileName: "webapp", model: "claude-opus",
        startedAt: .minutesAgo(1),
        queuePosition: 2
    )

    public static let provisioning = Session(
        status: .provisioning, branch: "fix/css-grid", profileName: "webapp", model: "claude-sonnet",
        startedAt: .minutesAgo(0)
    )

    public static let merging = Session(
        status: .merging, branch: "feat/search", profileName: "backend", model: "claude-opus",
        startedAt: .minutesAgo(20),
        diffStats: DiffStats(added: 210, removed: 44, files: 12)
    )

    public static let mergePending = Session(
        status: .mergePending, branch: "feat/search", profileName: "backend", model: "claude-opus",
        startedAt: .minutesAgo(22),
        diffStats: DiffStats(added: 210, removed: 44, files: 12),
        prUrl: URL(string: "https://github.com/org/my-app/pull/155"),
        latestActivity: "Checks: CI build (in_progress); Review required"
    )

    public static let complete = Session(
        status: .complete, branch: "fix/login", profileName: "my-app", model: "claude-opus",
        startedAt: .minutesAgo(45),
        diffStats: DiffStats(added: 67, removed: 22, files: 5),
        prUrl: URL(string: "https://github.com/org/my-app/pull/143")
    )

    public static let killed = Session(
        status: .killed, branch: "feat/payments", profileName: "backend", model: "claude-opus",
        startedAt: .minutesAgo(30),
        errorSummary: "Killed by user"
    )
}

private extension Date {
    static func minutesAgo(_ minutes: Int) -> Date {
        Date().addingTimeInterval(-Double(minutes) * 60)
    }
}
