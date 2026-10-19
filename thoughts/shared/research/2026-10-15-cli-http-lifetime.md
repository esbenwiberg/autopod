# CLI HTTP request lifetime

Date2026-10-15. Research source afbaa5dd (generic transport unchanged). Delegated
research_cli inspected transport/dependency defaults; root rechecked request and
central error handling. No live requests or new tests ran in this research.

Generic AutopodClient.request (api/client.ts:933) acquires a token, fetches once,
and on HTTP401 acquires another token and fetches again. It does not consume or
cancel the first401 response body before retry. The retry block catches token
and fetch failures together as AuthError; the initial fetch maps network failure
to DaemonUnreachableError. Successful text/JSON body failures escape as generic
errors; handleError swallows all JSON-read failures before status mapping.

There is no application signal/deadline. This is not the same as no underlying
timeouts: installed Undici8.10.2 supplies connect10s and header/body300s defaults;
body progress refreshes its inactivity timer. These defaults were source-read,
not elapsed-time tested. Initial token acquisition has no application deadline.

List/getSession/health are bounded stored-read endpoints, while the same generic
request also waits for synchronous image warming, installation, completion and
validation mutations. A universal short deadline would affect those operations
and would not prove server cancellation. updateFromBase has a separate fetch
implementation. Managed transport separately uses60s AbortSignal, pinned HTTPS,
bounded body reading/cancellation and no retry.

Inspect/status additionally loads optional task execution with catch-to-null;
its failure is deliberately tolerated. Abbreviated IDs perform a preliminary
list, so a per-request limit would not be a command-total limit. Workspace/install
readiness loops check their deadlines only between awaited HTTP requests.

The executable fixture can hold a response before headers, but currently cannot
serve a response sequence or unfinished response body. Its10s watchdog is fixture
failure, never a product timeout. Existing mocked-client tests cover one401retry
but do not establish disposal of the rejected response stream.

Source establishes an unowned first401 response body; a controlled unfinished
body and subsequent retry can characterize whether that connection remains live.
Any deadline policy requires separate planning; no universal timeout is selected
in this research.
