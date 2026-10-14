# jsonl-animate

Turn chat histories into a replayable pixel RPG village. People and agents become characters, messages become dialogue, and recorded tool calls send characters to work around town.

The player imports Codex JSONL, supported Claude Code JSONL (beta), and simple conversation JSON, including linked helpers. It includes play/pause, seeking, playback speed, character focus with a follow camera, an event journal, source inspection, and MP4 export.

Recorded dialogue now has deterministic emphasis and reactions for swearing, cheering, frustration, relief, and confusion. Try **Swearing & cheering · fictional demo** in the adventure picker, or [open it on your phone](https://chat-village-ewi.esbenw309505.chatgpt.site/?session=expressive). **Acting off** keeps highlighted text and static work/leisure props while removing acting and reaction motion; recorded travel still plays. Cues are limited wording heuristics and never override recorded check outcomes.

A larger woodland village now has winding paths, water and a bridge, six distinct buildings, a Harbor, and campfire resting spots. Reading, editing, investigating, checking, building, reviewing, waiting, and publishing have separate visual cues. Helpers appear at recruitment and carry recorded reports back to the guild. Try **Three helpers & a stubborn bug · fictional demo** or [open the new adventure](https://chat-village-ewi.esbenw309505.chatgpt.site/?session=village-demo).

Characters now act out their routines with original sitting, swinging, attack, hurt, nodding, and victory frames. Work adds a hammer and anvil, arena target, reading material, or terminal. Long idle gaps include log seats, reading, and an authored creek-side fishing spot. Input requests get an occasional attention gesture. Try **Workshop**, **Arena**, **Town Hall**, **Campfire**, and **Fishing break** in the story shortcuts. Leisure and work poses are presentation; recorded status and source evidence remain separate.

## Phone preview

[Open the private player](https://chat-village-ewi.esbenw309505.chatgpt.site) or [watch the clip](https://chat-village-ewi.esbenw309505.chatgpt.site/watch.html). Sign in with the owning ChatGPT account. The hosted snapshot supports playback and filtering its saved sessions; discovery, importing files, and rendering new exports remain local. Rebuild its static files with `node scripts/build-phone-preview.mjs`; source and hosting identity live in ignored `.local/phone-site/`.

## Run locally

Requires Node.js 22 or newer.

```sh
npm ci
npm start
```

Open **http://127.0.0.1:4173**. Use **Sessions** to browse discovered local Codex and Claude histories, search by project/session, or filter by provider. Choose a team, then focus a character in the party. **Refresh** checks for changed files. Select **Import chat** to import multiple sessions together, including their linked helper logs; sessions retain separate identities. In **Sessions**, check 2–4 sessions and select **Watch together** to combine up to 24 characters in one village. The teams start together in condensed presentation time, not synchronized historical time. Use **Follow a team**, a party button, or tap a character to focus. **Helpers arrive**, **First error**, **Needs you**, **Waiting for helpers**, **Town Hall**, **Cheering**, **Set sail**, and **Campfire** jump to recorded story moments when present. Files are processed by the local server; there are no external API calls during replay or export. Imported sessions remain in memory until the server stops.

For ordinary conversations, import a JSON array:

```json
[
  {"role": "user", "content": "What should we build?"},
  {"role": "assistant", "content": "A village for our conversations."}
]
```

**Export next 30s as MP4** renders from the current playhead. Export uses a bundled FFmpeg binary installed by `ffmpeg-static`; its install script must be enabled.

Choose **Follow agent** for a close camera that tracks the selected character and eases closer when they stop. **Whole village** keeps your character selected while showing everyone. Selecting **Follow everyone** clears the character focus. Scrubbing reproduces the same camera path; local MP4 exports preserve the current camera, character, and team selection. Acting off uses a steady zoom without camera easing.

Choose **Highlights** to watch a deterministic shorter edit: helper arrivals, failures, edits, reviews, reports, explicit input requests, reactions, and completed checks. Short lead-ins keep some walking; the camera automatically follows each featured actor. The scrubber and arrow buttons use highlight time, while the caption shows the original replay time. **Full replay** returns to that source position. Selecting an actor, journal event, or story moment also returns to full replay. Team filtering rebuilds the edit for that session. Labels describe recorded events; an edit is not proof of a fix. Simultaneous events share a cut and are always available in full replay.

In a shared village, numbered colored pennants identify each character's session. Matching banners above the map show session titles and toggle a team filter; numbers keep the teams distinguishable without relying on color alone. Try **2 teams in the village** in the adventure picker. Local exports preserve highlights and team selection. The private preview also includes a pre-rendered [highlight demo](https://chat-village-ewi.esbenw309505.chatgpt.site/highlights.html); its video links remain fixed demos, not new renders of arbitrary selections.

## Import and export from the terminal

```sh
npm run import -- parent.jsonl helper.jsonl --output .local/replay.json
npm run export -- --input .local/replay.json --output .local/replay.mp4
```

To export a clip:

```sh
npm run export -- --input .local/replay.json --start 30 --duration 45 --fps 12 --width 768 --output .local/clip.mp4
```

The CLI imports one Codex, Claude, or plain conversation at a time; the browser also groups multiple sessions in a single import. Run `npm run discover` to list local session metadata. Configure source folders and read provider limits in [session discovery](docs/session-discovery.md). Local selection manifests can choose an excerpt from large histories using `npm run import -- --selection .local/input-selection.json`. When that manifest exists, `npm start` also loads it as the default adventure and writes its compiled timeline to `.local/replay.json`. Private input references, compiled histories, and exports belong in ignored `.local/`.

## How the village works

| Recorded activity | Destination |
| --- | --- |
| Conversation and waiting | Town square |
| Explicit delegation and reports | Guild |
| Reading and searching | Archive |
| Editing and creation | Workshop |
| Tests, checks, and builds | Trial Arena |
| Reviewing changes and planning | Town Hall |
| Supplies and external requests | Depot |
| Publishing commands | Harbor |
| Explicit input request | Guild noticeboard · amber ! |
| Explicit helper wait | Guild benches · blue hourglass |
| Recorded running tool | Its workstation · clock |
| Finished turn or unknown idle gap | Campfire · green tick or muted z |

Waiting reasons come from explicit tool calls and results. Input requests rise to the top of the party, with a focus button. Exact helper IDs produce named waits and a visible link when focused. An unmatched call shows “Awaiting tool result”; a running result shows “Tool still running.” Only recorded final/end-turn markers produce “Turn finished,” which does not assert task success. Unknown gaps use a muted idle badge. Long gaps allow a campfire visit and return; short pauses stay in place. The Harbor boat departs for successful, attributable publication commands, excluding failures, dry runs, and ambiguous batches.

Explicit subagents get stable characters and their own timelines. They can work alongside the lead. Missing helper transcripts produce a status character without invented dialogue. Tool results preserve recorded errors and uncertainty; a successful shell exit alone is not labeled “tests passed.”

The importer preserves source order, call/result relationships, explicit dependencies, original message text, and source file/line references. It statically inspects nested tool orchestration without executing imported code. System/developer prompts, internal analysis, host context, and inherited helper history are excluded from dialogue. This is filtering, **not a general-purpose secret scrubber**: visible messages and tool output remain in the replay.

The scene compiler chooses paths and condensed presentation times once. Rendering is a function of that timeline and playback time, so seeking reproduces scene state. Browser playback and MP4 export use the same renderer and assets. Timings are choreography, not measured work durations. Pixel reproducibility is tested in the pinned local renderer; cross-platform font/encoder output is not guaranteed byte-identical.

## Current limits

- Codex support follows observed export shapes. Claude Code support is beta and fixture-tested; no local Claude histories were available. Discovery and session/provider filtering work locally. Near realtime streaming and a phone connection to the collector are still planned.
- A flat map with authored winding routes, walking and action sprites, props, and status icons. Interiors, map occlusion, and sound are future work.
- Long messages are paginated in condensed playback; pause and use source inspection to read the complete text.
- Nested tool classification is conservative static inspection. Dynamic code and ambiguous batched outputs remain generic or uncertain.
- Large sessions are held in memory. Browser imports have a 150 MB request limit; discovered replay groups have a 120 MiB limit. The browser exports short clips; the CLI can export the whole timeline.

The maps are generated art; the expanded version and prompt are documented in [village v3 art](docs/village-v3-art.md) (with older assets retained). Character sheets are original game sprites used for this local prototype; see [exact sources, credits, and source conditions](docs/asset-production.md) before redistribution. The bundled font uses the SIL Open Font License.

## Verification and design

```sh
npm test
```

Tests cover inherited history, duplicate events, nested tool inspection, polling/results, explicit delegation, source dependencies, deterministic seeking, plain conversation import, sprite frames, rendered pixel stability, decodable MP4 output, recruitment timing, bridge routing, and isolation/determinism when combining teams, explicit waiting reasons, turn completion, continuous resting movement, evidence-gated boat departures, action-frame alignment, work/result pose selection, and deterministic acting with reduced motion.

The shared fixture is fictional and contains no private conversation data. A real local excerpt has also been replayed with 735 normalized events, a user, a lead, and three helper characters; its input and exports remain ignored.

See [replay design](docs/replay-design.md), [art direction](docs/art-direction.md), and [asset production](docs/asset-production.md).

Local discovery has been checked against 127 Codex logs grouped into 51 sessions. The hosted preview does not automatically publish newly discovered histories.
