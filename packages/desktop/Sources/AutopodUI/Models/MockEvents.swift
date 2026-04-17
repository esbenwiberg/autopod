import Foundation

public enum MockEvents: Sendable {

    /// Simulates a typical running pod's event log
    public static let running: [AgentEvent] = {
        let base = Date().addingTimeInterval(-8 * 60)
        var events: [AgentEvent] = []
        var id = 1

        func add(_ offset: TimeInterval, _ type: AgentEventType, _ summary: String, _ detail: String? = nil, toolName: String? = nil) {
            events.append(AgentEvent(
                id: id, timestamp: base.addingTimeInterval(offset),
                type: type, summary: summary, detail: detail, toolName: toolName
            ))
            id += 1
        }

        add(0,    .status,     "Pod started", "Transitioning from queued → provisioning")
        add(3,    .status,     "Container ready", "Transitioning from provisioning → running")
        add(5,    .progress,   "Phase 1/10: Understanding the codebase")
        add(8,    .toolUse,    "Read src/routes/index.ts", "Read 142 lines", toolName: "Read")
        add(12,   .toolUse,    "Read src/routes/users.ts", "Read 89 lines", toolName: "Read")
        add(15,   .toolUse,    "Grep \"router\" in src/", "Found 14 matches across 8 files", toolName: "Grep")
        add(20,   .output,     "The API uses Express with a modular router pattern. Each route file exports a router instance...")
        add(25,   .progress,   "Phase 2/10: Planning implementation")
        add(28,   .plan,       "Refactor API to controller pattern", "1. Create base controller class\n2. Migrate route handlers\n3. Add DI container\n4. Write unit tests\n5. Integration tests")
        add(30,   .output,     "I'll refactor the API to use a controller pattern with dependency injection. This will make testing easier.")
        add(45,   .progress,   "Phase 3/10: Creating controller base class")
        add(48,   .toolUse,    "Write src/controllers/base.ts", "Created new file, 45 lines", toolName: "Write")
        add(50,   .fileChange, "Created src/controllers/base.ts", "+45 lines")
        add(55,   .toolUse,    "Write src/controllers/users.ts", "Created new file, 78 lines", toolName: "Write")
        add(57,   .fileChange, "Created src/controllers/users.ts", "+78 lines")
        add(65,   .progress,      "Phase 4/10: Migrating routes")
        add(70,   .toolUse,    "Edit src/routes/users.ts", "Replaced 34 lines")
        add(72,   .fileChange, "Modified src/routes/users.ts", "+12 -34 lines")
        add(80,   .toolUse,    "Edit src/routes/index.ts", "Updated imports")
        add(82,   .fileChange, "Modified src/routes/index.ts", "+3 -5 lines")
        add(90,   .progress,      "Phase 5/10: Adding dependency injection")
        add(95,   .toolUse,    "Write src/di/container.ts", "Created new file, 32 lines")
        add(97,   .fileChange, "Created src/di/container.ts", "+32 lines")
        add(110,  .progress,      "Phase 6/10: Writing unit tests")
        add(115,  .toolUse,    "Write src/controllers/users.test.ts", "Created new file, 120 lines")
        add(120,  .fileChange, "Created src/controllers/users.test.ts", "+120 lines")
        add(130,  .toolUse,    "Bash: npm test", "Running test suite...")
        add(140,  .error,      "Test failure: UserController.getById", "Expected 200 but got 404. The route parameter 'id' is not being passed to the controller.")
        add(145,  .toolUse,    "Edit src/routes/users.ts", "Fixed parameter forwarding")
        add(148,  .fileChange, "Modified src/routes/users.ts", "+2 -1 lines")
        add(155,  .toolUse,    "Bash: npm test", "All 12 tests passing")
        add(160,  .progress,      "Phase 7/10: Integration tests")
        add(165,  .toolUse,    "Write src/controllers/users.integration.test.ts", "Created new file, 95 lines")
        add(170,  .fileChange, "Created src/controllers/users.integration.test.ts", "+95 lines")
        add(180,  .progress,      "Phase 8/10: Writing API tests")
        add(185,  .toolUse,    "Edit src/routes/users.ts", "Added validation middleware")
        add(188,  .fileChange, "Modified src/routes/users.ts", "+8 -2 lines")

        return events
    }()

    /// Simulates a failed pod's event log
    public static let failed: [AgentEvent] = {
        let base = Date().addingTimeInterval(-11 * 60)
        var events: [AgentEvent] = []
        var id = 100

        func add(_ offset: TimeInterval, _ type: AgentEventType, _ summary: String, _ detail: String? = nil) {
            events.append(AgentEvent(
                id: id, timestamp: base.addingTimeInterval(offset),
                type: type, summary: summary, detail: detail
            ))
            id += 1
        }

        add(0,    .status,     "Pod started")
        add(5,    .status,     "Container ready")
        add(10,   .progress,      "Phase 1/10: Understanding the codebase")
        add(20,   .toolUse,    "Read src/utils/perf.ts", "Read 210 lines")
        add(40,   .progress,      "Phase 2/10: Profiling bottleneck")
        add(50,   .toolUse,    "Bash: npm run benchmark", "Running performance benchmark...")
        add(70,   .output,     "The bottleneck is in the serialization layer. Each response serializes nested objects redundantly.")
        add(80,   .progress,      "Phase 3/10: Implementing fix")
        add(90,   .toolUse,    "Edit src/utils/perf.ts", "Added memoized serializer")
        add(95,   .fileChange, "Modified src/utils/perf.ts", "+22 -5 lines")
        add(100,  .toolUse,    "Bash: npm run build", "Build started...")
        add(120,  .error,      "Build failed — tsc exit 1", "src/utils/perf.ts:44 — Type 'MemoCache<string>' is not assignable to type 'SerializeResult'. Property 'toJSON' is missing.")
        add(125,  .toolUse,    "Edit src/utils/perf.ts", "Attempt 1 fix: added toJSON method")
        add(130,  .toolUse,    "Bash: npm run build", "Build started...")
        add(145,  .error,      "Build failed — tsc exit 1", "src/utils/perf.ts:52 — Cannot read property 'cache' of undefined. Initialization order issue.")
        add(150,  .status,     "Pod failed", "Transitioning from running → failed (attempt 2 of 3)")

        return events
    }()

    /// Short log for an awaiting_input pod
    public static let awaitingInput: [AgentEvent] = {
        let base = Date().addingTimeInterval(-5 * 60)
        return [
            AgentEvent(id: 200, timestamp: base, type: .status, summary: "Pod started"),
            AgentEvent(id: 201, timestamp: base.addingTimeInterval(4), type: .status, summary: "Container ready"),
            AgentEvent(id: 202, timestamp: base.addingTimeInterval(10), type: .progress, summary: "Phase 1/10: Understanding requirements"),
            AgentEvent(id: 203, timestamp: base.addingTimeInterval(20), type: .toolUse, summary: "Read src/auth/config.ts", detail: "Read 45 lines"),
            AgentEvent(id: 204, timestamp: base.addingTimeInterval(30), type: .output, summary: "The codebase doesn't have any OAuth implementation yet. I need to decide on a provider strategy."),
            AgentEvent(id: 205, timestamp: base.addingTimeInterval(35), type: .escalation, summary: "Escalation: Which OAuth provider should I use — Google, GitHub, or both?", detail: "Agent needs human input to proceed with authentication strategy"),
        ]
    }()
}
