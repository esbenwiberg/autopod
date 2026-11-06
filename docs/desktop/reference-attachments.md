# Viewing reference attachments

Open a pod, then **Work → Task**. Its **Reference attachments** card appears
below the task text when its frozen launch includes uploaded inputs.

- Image rows show a thumbnail, filename and file size. Select a row for a larger
  native preview; use **Zoom in** to inspect it in a scrollable view, **Fit image**
  to fit it again, and **Done** (or Escape) to close it.
- Text references, including HTML and SVG, show bounded source text only. Active
  content is not executed and external assets are not fetched. The source preview
  is limited to 256 KiB.
- **Save…** exports the complete original file, including PDFs and other formats
  without an inline preview. Saving does not automatically open or execute it.
- Preview images are decoded with bounded dimensions (200 pixels for thumbnails,
  4096 for the larger preview); saving retains the original resolution and bytes.

These are **provided inputs, not added to source**. **Evidence → Screenshots**
continues to show generated validation/review screenshots, not uploaded inputs.

Metadata and bytes use the existing owner-scoped configuration/input APIs. The
client verifies downloaded length and SHA-256 against the frozen manifest. A
missing, inaccessible or corrupt reference displays an error and retry action;
it is not represented as an empty set. Pods without inputs have no attachments
card. Changing pods or daemon connections discards the previous view's state.

This desktop change does not require a daemon schema change or worker wake-up.
An older daemon without the configuration/input endpoints cannot provide these
previews. Build/relaunch the updated desktop to see the new card.
