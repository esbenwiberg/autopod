Profile with outputMode artifact and no repoUrl passes validation
Profile with outputMode pr and no repoUrl fails validation with a clear error
ReferenceRepo type is exported from @autopod/shared
Session.referenceRepos and Session.artifactsPath fields exist in the shared type
CreateSessionRequest accepts referenceRepos array and referenceRepoPat string
Migration 040 applies cleanly to a fresh database
session-repository round-trips referenceRepos and artifactsPath without data loss
Artifact session with no profile.repoUrl provisions without creating a worktree
Artifact session with profile.repoUrl creates a worktree but does not mount it in the container
Container /workspace is empty at session start for artifact sessions
Each reference repo is cloned to /repos/<mountPath>/ inside the container
Failed reference repo clone logs a warning and does not fail the session
Agent spawns successfully for artifact sessions
Branch for artifact sessions is in research/<id> format
Session completion extracts /workspace contents to the host artifactsPath
session.artifactsPath is set after artifact session completes
Artifact branch is pushed to profile.repoUrl when repoUrl is set
Artifact branch push failure is non-fatal and session still reaches complete status
GET /sessions/:id/files returns artifact files when session.worktreePath is null
GET /sessions/:id/files/content returns artifact file content when session.worktreePath is null
GET /sessions/:id/files continues to read from worktreePath for non-artifact sessions
ap research <profile> <task> creates a session with outputMode artifact
ap research --repo flag is repeatable and maps to referenceRepos
ap research --repo-pat flag maps to referenceRepoPat
Desktop Markdown tab is the default tab for completed artifact sessions
Desktop Markdown tab lists artifact files from the files API
Desktop Markdown tab renders selected file content as markdown
Artifact sessions with no files show an empty Markdown tab without crashing
PR sessions are unaffected by all changes
Workspace pod sessions are unaffected by all changes
TypeScript strict mode passes across all packages
