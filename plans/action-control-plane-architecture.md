# Action Control Plane — Architecture & Workflow

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                        SANDBOX CONTAINER                            │
│                                                                     │
│   ┌──────────┐    MCP calls    ┌──────────────────────────────┐    │
│   │  Claude   │───────────────▶│  Escalation MCP Server       │    │
│   │  Agent    │                │  (localhost:3100/mcp/{sid})   │    │
│   │          │◀───────────────│                              │    │
│   │          │   responses     │  Tools:                      │    │
│   │          │                │  ├── ask_human                │    │
│   └──────────┘                │  ├── report_plan              │    │
│       │                       │  ├── read_issue    ◀─ dynamic │    │
│       │ (blocked)             │  ├── search_issues ◀─ dynamic │    │
│       ▼                       │  ├── enrich_context◀─ dynamic │    │
│   ✗ No internet               │  └── ...                      │    │
│   ✗ No API tokens             └──────────┬───────────────────┘    │
│   ✗ No direct API access                 │                         │
└──────────────────────────────────────────│─────────────────────────┘
                                           │
                              JSON-RPC over HTTP
                                           │
┌──────────────────────────────────────────▼─────────────────────────┐
│                          DAEMON (Host)                              │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │                    Session Bridge                             │  │
│  │  executeAction(sessionId, name, params) ──┐                  │  │
│  │  getAvailableActions(sessionId)           │                  │  │
│  └───────────────────────────────────────────│──────────────────┘  │
│                                              │                      │
│  ┌───────────────────────────────────────────▼──────────────────┐  │
│  │                    Action Engine                              │  │
│  │                                                               │  │
│  │  1. Resolve action from registry                              │  │
│  │  2. Check overrides (approval, resources, disabled)           │  │
│  │  3. Validate params (required, type, enum)                    │  │
│  │  4. Apply defaults                                            │  │
│  │  5. Dispatch to handler ─────────────────────────┐            │  │
│  │  6. Process response (quarantine → PII)          │            │  │
│  │  7. Write audit trail                            │            │  │
│  └──────────────────────────────────────────────────│────────────┘  │
│                                                     │               │
│  ┌──────────────────────────────────────────────────▼────────────┐  │
│  │                    Handler Dispatch                            │  │
│  │                                                               │  │
│  │  ┌─────────┐  ┌─────────┐  ┌───────────┐  ┌──────────────┐  │  │
│  │  │ GitHub  │  │  ADO    │  │Azure Logs │  │ Generic HTTP │  │  │
│  │  │ Handler │  │ Handler │  │  Handler  │  │   Handler    │  │  │
│  │  │         │  │         │  │           │  │              │  │  │
│  │  │ Octokit │  │  WIQL   │  │   KQL     │  │  Template    │  │  │
│  │  │ Paging  │  │  Basic  │  │  Managed  │  │  Substitution│  │  │
│  │  │ RateLim │  │  Auth   │  │  Identity │  │  Any REST    │  │  │
│  │  └────┬────┘  └────┬────┘  └─────┬─────┘  └──────┬───────┘  │  │
│  │       │            │             │                │           │  │
│  └───────│────────────│─────────────│────────────────│───────────┘  │
│          │            │             │                │               │
│          ▼            ▼             ▼                ▼               │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │                External APIs (daemon has the tokens)           │  │
│  │  api.github.com    dev.azure.com    api.loganalytics.io  ... │  │
│  └───────────────────────────────────────────────────────────────┘  │
│                                                                     │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │                    Content Processing Pipeline                │  │
│  │                                                               │  │
│  │  ┌─────────────┐    ┌─────────────┐    ┌──────────────────┐  │  │
│  │  │ Quarantine  │───▶│ PII Sanitize│───▶│ Field Whitelist  │  │  │
│  │  │ (injection  │    │ (emails,    │    │ (only configured │  │  │
│  │  │  detection) │    │  API keys,  │    │  fields pass)    │  │  │
│  │  │             │    │  IPs, etc.) │    │                  │  │  │
│  │  │ score>0.8:  │    │             │    │ redactFields:    │  │  │
│  │  │  BLOCK      │    │ Presets:    │    │  user.login      │  │  │
│  │  │ score>0.5:  │    │  strict     │    │  user.email      │  │  │
│  │  │  QUARANTINE │    │  standard   │    │  assignee.login  │  │  │
│  │  │ score<0.5:  │    │  relaxed    │    │                  │  │  │
│  │  │  PASS       │    │             │    │                  │  │  │
│  │  └─────────────┘    └─────────────┘    └──────────────────┘  │  │
│  └───────────────────────────────────────────────────────────────┘  │
│                                                                     │
│  ┌────────────────┐  ┌──────────────┐  ┌──────────────────────┐    │
│  │  Audit Trail   │  │  Event Bus   │  │  Notifications       │    │
│  │  (SQLite)      │  │  (sanitized) │  │  (Teams, sanitized)  │    │
│  └────────────────┘  └──────────────┘  └──────────────────────┘    │
└─────────────────────────────────────────────────────────────────────┘
```

## MCP Proxy Flow

```
Agent in container                Daemon                    Real MCP Server
       │                            │                            │
       │  POST /mcp-proxy/          │                            │
       │  {serverName}/{sessionId}  │                            │
       │───────────────────────────▶│                            │
       │  (no auth headers)         │                            │
       │                            │  Look up server config     │
       │                            │  Inject auth headers       │
       │                            │                            │
       │                            │  POST {real-server-url}    │
       │                            │───────────────────────────▶│
       │                            │  Authorization: Bearer ... │
       │                            │                            │
       │                            │◀───────────────────────────│
       │                            │  Raw response              │
       │                            │                            │
       │                            │  PII sanitize response     │
       │                            │  Audit log                 │
       │                            │                            │
       │◀───────────────────────────│                            │
       │  Sanitized response        │                            │
       │  (no tokens visible)       │                            │
```

## Data Flow: Action Execution

```mermaid
sequenceDiagram
    participant Agent as Claude Agent
    participant MCP as MCP Server
    participant Bridge as Session Bridge
    participant Engine as Action Engine
    participant Registry as Action Registry
    participant Handler as Handler (GitHub/ADO/HTTP)
    participant Pipeline as Content Pipeline
    participant Audit as Audit Repository
    participant API as External API

    Agent->>MCP: read_issue(repo: "org/app", issue_number: 42)
    MCP->>Bridge: executeAction("sess-123", "read_issue", {...})
    Bridge->>Engine: execute({sessionId, actionName, params}, policy)

    Engine->>Registry: getAction("read_issue", policy)
    Registry-->>Engine: ActionDefinition (handler: "github")

    Note over Engine: Validate params<br/>Check overrides<br/>Apply defaults

    Engine->>Handler: execute(action, params)
    Handler->>API: GET api.github.com/repos/org/app/issues/42
    Note over Handler: Bearer token injected<br/>Rate limit tracked
    API-->>Handler: {title, body, user: {login: "alice", email: "a@co.com"}, ...}
    Handler-->>Engine: Filtered by response.fields

    Engine->>Pipeline: processContentDeep(data, {sanitization, quarantine})
    Note over Pipeline: 1. Quarantine scan<br/>2. PII strip emails<br/>3. Redact user.login
    Pipeline-->>Engine: {result, sanitized: true, threats: []}

    Engine->>Audit: insert({sessionId, actionName, params, ...})
    Engine-->>Bridge: {success: true, data: sanitized, sanitized: true}
    Bridge-->>MCP: ActionResponse
    MCP-->>Agent: JSON with [EMAIL_REDACTED], no raw tokens
```

## Content Processing Pipeline

```mermaid
flowchart TD
    A[Raw Content] --> B{Quarantine<br/>Enabled?}
    B -->|No| D[PII Sanitization]
    B -->|Yes| C[Injection Detection]

    C --> C1{Threat Score}
    C1 -->|score ≥ 0.8| BLOCK[❌ BLOCKED<br/>Content omitted]
    C1 -->|0.5 ≤ score < 0.8| WRAP[⚠️ QUARANTINE<br/>Wrapped with warning]
    C1 -->|score < 0.5| PASS[✅ Pass through]

    WRAP --> D
    PASS --> D

    D --> D1{Preset}
    D1 -->|strict| D2[Emails + Phones + IPs<br/>+ API Keys + AWS Keys]
    D1 -->|standard| D3[Emails + API Keys<br/>+ AWS Keys + Azure Keys]
    D1 -->|relaxed| D4[API Keys only]

    D2 --> E[Field Whitelist]
    D3 --> E
    D4 --> E

    E --> F[redactFields<br/>user.login → REDACTED<br/>user.email → REDACTED]
    F --> G[✅ Sanitized Output]

    style BLOCK fill:#ff6b6b,color:#fff
    style WRAP fill:#ffd93d,color:#000
    style PASS fill:#6bff6b,color:#000
    style G fill:#6bff6b,color:#000
```

## Integration Points (All 5 Wired)

```mermaid
flowchart LR
    subgraph Sources["Untrusted Data Sources"]
        GH[GitHub API]
        ADO[Azure DevOps]
        AZ[Azure Monitor]
        HTTP[Custom HTTP]
        MCP_EXT[External MCP]
        FETCH[Fetched Sections]
    end

    subgraph Pipeline["Content Processing"]
        CP[processContent /<br/>processContentDeep]
    end

    subgraph Outputs["Sanitized Outputs"]
        AGENT[Agent Response]
        WS[WebSocket Broadcast]
        TEAMS[Teams Notification]
        CLAUDE[CLAUDE.md Sections]
    end

    GH --> |1. Action Engine| CP
    ADO --> |1. Action Engine| CP
    AZ --> |1. Action Engine| CP
    HTTP --> |1. Action Engine| CP
    MCP_EXT --> |2. MCP Proxy| CP
    FETCH --> |5. Section Resolver| CP

    CP --> AGENT
    CP --> |3. Event Bus| WS
    CP --> |4. Notification Svc| TEAMS
    CP --> CLAUDE

    style CP fill:#4ecdc4,color:#000
    style Pipeline fill:#f0f0f0,stroke:#333
```

## Profile Configuration: Coding vs Research Pod

```
┌─────────────────────────────────┐   ┌─────────────────────────────────┐
│       CODING POD                │   │       RESEARCH POD              │
│                                 │   │                                 │
│  networkPolicy:                 │   │  networkPolicy:                 │
│    enabled: true                │   │    enabled: true                │
│    allowedHosts: []             │   │    allowedHosts:                │
│    ▶ Internet BLOCKED           │   │      - *.github.com            │
│                                 │   │      - *.stackoverflow.com     │
│  actionPolicy:                  │   │      - arxiv.org               │
│    enabledGroups:               │   │    replaceDefaults: true        │
│      - github-issues            │   │    ▶ LIMITED internet           │
│      - github-prs              │   │                                 │
│      - azure-logs              │   │  actionPolicy:                  │
│      - custom                  │   │    enabledGroups:               │
│    sanitization:                │   │      - github-issues            │
│      preset: standard          │   │      - github-code             │
│    customActions:               │   │    sanitization:                │
│      - enrich_context          │   │      preset: standard          │
│      - get_feature_flags       │   │    quarantine:                  │
│                                 │   │      enabled: true              │
│  outputMode: pr                 │   │      threshold: 0.3            │
│    ▶ Build → Validate → PR     │   │      blockThreshold: 0.8       │
│                                 │   │                                 │
│  CLAUDE.md says:                │   │  outputMode: artifact           │
│    "Internet BLOCKED"           │   │    ▶ No build, no validation   │
│    "Push handled by system"     │   │    ▶ Output = research-output  │
│                                 │   │                                 │
└─────────────────────────────────┘   │  CLAUDE.md says:                │
                                      │    "LIMITED internet access"    │
                                      │    "Write to research-output"   │
                                      └─────────────────────────────────┘
```

## Package Structure

```
packages/
├── shared/src/
│   ├── types/actions.ts          ← ActionDefinition, ActionPolicy, ParamDef, AuthConfig
│   ├── schemas/action-definition.schema.ts  ← Zod validation
│   └── sanitize/
│       ├── patterns.ts           ← PII regex + injection detection patterns
│       ├── sanitize.ts           ← sanitize(), sanitizeDeep()
│       ├── quarantine.ts         ← quarantine(), threat scoring
│       ├── processor.ts          ← processContent(), processContentDeep()
│       └── processor.test.ts     ← 37 tests
│
├── daemon/src/
│   ├── actions/
│   │   ├── action-engine.ts      ← Orchestrator (validate → dispatch → sanitize → audit)
│   │   ├── action-registry.ts    ← Loads built-in + custom actions from profile
│   │   ├── audit-repository.ts   ← SQLite audit trail
│   │   ├── generic-http-handler.ts  ← Template substitution, any REST API
│   │   ├── handlers/
│   │   │   ├── handler.ts        ← Common interface, pickFields, fetchWithTimeout
│   │   │   ├── github-handler.ts ← REST API, pagination, rate limits
│   │   │   ├── ado-handler.ts    ← WIQL, Basic auth, batch fetch
│   │   │   └── azure-logs-handler.ts  ← KQL, managed identity, tabular→objects
│   │   ├── defaults/
│   │   │   ├── github-issues.json  (3 actions)
│   │   │   ├── github-prs.json    (3 actions)
│   │   │   ├── github-code.json   (2 actions)
│   │   │   ├── ado-workitems.json  (2 actions)
│   │   │   └── azure-logs.json    (3 actions)
│   │   ├── action-engine.test.ts        ← 9 unit tests
│   │   ├── action-registry.test.ts      ← 5 unit tests
│   │   ├── action-integration.test.ts   ← 6 integration tests (real DB + mock HTTP)
│   │   └── handlers/handler.test.ts     ← 9 utility tests
│   │
│   ├── api/
│   │   ├── mcp-handler.ts        ← Modified: passes available actions to MCP server
│   │   └── mcp-proxy-handler.ts  ← NEW: proxies injected MCP servers, strips PII
│   │
│   ├── sessions/
│   │   ├── session-bridge-impl.ts ← Extended: executeAction, getAvailableActions
│   │   ├── session-manager.ts     ← Modified: MCP URL rewrite, action resolution
│   │   ├── claude-md-generator.ts ← Extended: Operating Environment section
│   │   ├── event-bus.ts          ← Extended: sanitizing decorator on emit
│   │   └── section-resolver.ts   ← Extended: processContent on fetched sections
│   │
│   ├── notifications/
│   │   └── notification-service.ts ← Extended: sanitize card payloads
│   │
│   └── db/migrations/
│       └── 007_actions.sql        ← action_policy + output_mode + action_audit table
│
└── escalation-mcp/src/
    ├── session-bridge.ts          ← Extended: executeAction, getAvailableActions
    ├── server.ts                  ← Extended: dynamic action tool registration
    └── tools/actions.ts           ← NEW: generic action tool handler
```
