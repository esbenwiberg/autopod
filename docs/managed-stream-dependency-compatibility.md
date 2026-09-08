# Managed archive stream dependency compatibility

Status: locally validated repair; not live provider/artifact acceptance.

A fresh frozen-lock dependency installation at published AutoPod revision
`f646cfccd0d5e8c072e52f7a948879304faedbd4` exposed ten errors in the dedicated
managed TypeScript check. The updated tar-stream/streamx declarations type data
chunks as unknown and expose a smaller stream interface than Node's full readable
interface. The standard declaration build did not exercise that complete check.

Docker archive collection and managed artifact packing/extraction now verify
`Buffer.isBuffer` before using chunk bytes. Nonbinary chunks fail the operation;
no unchecked chunk casts were introduced. Extraction accepts the error, pipe and
optional destruction operations shared by Node and tar-stream sources. Entry
completion calls the continuation explicitly after asynchronous writes finish.

Artifact packing observes its output promise and entry-writing promise together,
and handles entry stream errors. A packing failure therefore cannot leave an
unhandled rejection while another entry callback is pending. Normal tar bytes,
artifact integrity checks, link/path denials, file limits, source verification
ordering, schemas, migrations and grants retain their existing behavior.

Regression cases cover Node and tar-stream sources and malformed chunks during
extraction, artifact packing and Docker writes. The malformed Docker packing case
must produce no putArchive call; invalid artifact chunks must produce no bundle.
The change is internal and inherits the existing zero additional voice turns,
clarifications, approvals and routine interruptions. Live acceptance remains a
separate gate, and the managed lane remains disabled by default.

Before building another canary, independently review and publish this patch, then
install the exact published lockfile and run `tsc --noEmit -p tsconfig.managed.json`
from packages/daemon along with the build and stream/provider tests. Reusing a
previous checkout's node_modules does not establish dependency compatibility.
