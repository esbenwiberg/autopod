# Asset production

## Expanded village

The previous expanded map is `public/assets/village-v2.png`; see [art direction, method, and final prompt](village-v2-art.md). The original map below is retained for versioned replay compatibility.

## Village background

- Asset: `public/assets/village.png`
- Dimensions: 1254 × 1254 pixels, opaque PNG.
- Created: 14 October 2026.
- Method: built-in `image_gen.imagegen`, edit mode; no CLI or postprocessing.
- Approved source: `docs/concepts/coding-village-v1.png`.
- Generated original: `/Users/ewi/.codex/generated_images/01a13a7d-951d-7e01-9dfd-2e66941d1f40/exec-99e49cc2-2c4d-468a-b956-b28babda3fc1.png`.
- The generated original was copied byte-for-byte to the project asset.
- Visual inspection confirms no characters, speech bubbles, title label or dialogue UI remain. Four buildings and their signs are preserved.

### Village generation prompt

```text
Use case: precise-object-edit.
Asset type: production background map for a Pokémon-style 2D coding-agent replay game.
Input image 1 is the approved edit target and exact visual style reference.
Primary request: make an empty village background from this image, retaining the gorgeous detailed pixel-art style, colors, tree shapes, roofs, buildings, broad warm sandy paths, daylight and overhead oblique game camera. The four buildings stay in the same quadrants: GUILD upper left, ARCHIVE upper right, WORKSHOP lower left, CHECKS lower right; retain their readable wooden signs and distinctive props.
Remove EVERY character completely, including Gengar, Bulbasaur, Pikachu, Squirtle, Red, and the portrait. Remove ALL dialogue bubbles, the entire bottom dialogue panel, and the CONCEPT FRAME label. Replace these removed areas naturally with underlying paths, grass, village terrain, and extend the map all the way to the bottom. The result is a square image containing only the environment with zero UI overlays.
The central crossroads must be wide, fully clear and walkable, connecting the path to each building's front door. Maintain the monitor and tools on the workshop workbench, the archive bookshelves, the checks board and guild notice board. No humans, no animals, no Pokémon anywhere. No stray character shadows. Preserve the rich reference design; this is an empty stage for sprites composited later.
```

### Scene integration

Coordinates below are normalized to the full square image, with (0, 0) at its top left:

| Location | Approximate anchor |
| --- | --- |
| Town square / main crossroads | (0.50, 0.52) |
| Guild doorstep | (0.25, 0.33) |
| Archive doorstep | (0.75, 0.35) |
| Workshop doorstep | (0.16, 0.73) |
| Workshop workbench | (0.26, 0.74) |
| Checks doorstep | (0.84, 0.76) |
| North entrance | (0.48, 0.07) |
| South entrance | (0.50, 0.94) |

This first background is one flat image. It has no separate foreground occlusion mask, terrain collision data, or editable tile layers. Actor routes must stay in open spaces and avoid trees, roofs, furniture and signage. Workshop access includes open grass around its workbench; not all proposed route segments are painted paths.

The image is an AI-generated interpretation of the approved Pokémon-style concept, not an extracted game asset or a pixel-for-pixel recreation of an official game.

## Character sheet: generation blocked

The requested asset `public/assets/characters.png` was **not created**. Two identical attempts to create a transparent character sheet were rejected by the built-in image service at its output-moderation stage, with category `other` and no specific explanation. No fallback API, CLI, image-editing program, or silent replacement cast was used.

- Attempt 1 request ID: `028dbf92-ab2a-47e8-9b44-5344cdf4e26e`.
- Attempt 2 request ID: `22dfb09e-57d2-44a5-add0-24e545e38b47`.
- Both requested `transparent_background: true`.
- Both used the approved concept as the only style reference.
- Because no image was returned, no alpha validation or actual frame-coordinate inspection was possible.

### Requested character prompt

```text
Use case: stylized-concept.
Asset type: production transparent pixel-art character sprite sheet for a Pokémon-style overhead 2D game.
Input image 1 is STYLE REFERENCE ONLY; do not reproduce its map or layout.
Primary request: create exactly 20 full-body character sprites on a REAL TRANSPARENT ALPHA background, arranged in a rigorous 4 columns by 5 rows evenly spaced grid. Desired sheet 1024 pixels wide by 1280 pixels high, with 20 equal 256×256 cells. Do not draw the grid, lines, labels, captions, borders, cast shadows, backgrounds, floor, or any UI.
Row 1: Red, the recognizable Pokémon trainer in his red-and-white cap, red vest over dark shirt, blue jeans, yellow backpack, shoes.
Row 2: Pikachu, recognizable yellow Pokémon, black-tipped ears, red cheeks, lightning-bolt tail.
Row 3: Bulbasaur, recognizable turquoise green Pokémon with darker spots, red eyes, green plant bulb on its back.
Row 4: Squirtle, recognizable blue turtle Pokémon with tan shell and curled tail.
Row 5: Gengar, recognizable stocky purple ghost Pokémon with spikes and mischievous red eyes.
Every row has the SAME character in exactly these four directions: column 1 facing DOWN toward viewer; column 2 facing LEFT; column 3 facing RIGHT; column 4 facing UP away from viewer. Each sprite is standing at rest in a walking-ready pose, with a full body visible, in the slight overhead perspective and rich pixel-art style of the reference.
Within every 256×256 cell place the same centered foot anchor at local x=128, y=220; character body should fit between local x=40..216 and local y=40..220. Keep ample transparent margin around ALL sprites, including ears and tails; none can touch or cross another cell.
Consistent scale across directional views of each character. Red should be about 170 pixels tall, Pikachu about 145 pixels tall including ears, Bulbasaur about 115 pixels tall, Squirtle about 125 pixels tall, Gengar about 135 pixels tall. All have the same ground-level foot baseline.
Render crisp visible square pixel clusters, charming classic Pokémon RPG overworld art, dark outlines, warm highlights, slightly painterly detailed pixel shading matching the reference. Flat colors behind the sprites are forbidden: actual PNG transparency. Twenty sprites only, no missing direction, no extra faces, no props, no baked ground shadows.
```

### Intended layout (not verified output)

The request specified a 4-column × 5-row sheet: rows Red, Pikachu, Bulbasaur, Squirtle, Gengar; columns down, left, right, up. It requested 1024 × 1280 pixels, 256 × 256 cells and a local foot anchor of (128, 220). These are desired values only and must not be treated as metadata for an existing asset.

Even if generated successfully, this initial sheet would contain only one idle pose per direction; movement would be implemented with position interpolation and a small hop. Proper gait cycles, separate work poses, emotes and layered occlusion remain future asset work.

## Production sprite fallback: upstream walking and idle sheets

The first playable build now has five real actor assets, downloaded from primary source repositories without modifying image bytes. The failed generated `characters.png` sheet is not needed by this pack.

- Runtime metadata: `public/assets/sprites.json`.
- Original role mapping, retained for legacy replay compatibility: user → Red, lead → Pikachu, helper 1 → Bulbasaur, helper 2 → Squirtle, helper 3 → Gengar.
- Pokémon source: [PMDCollab/SpriteCollab](https://github.com/PMDCollab/SpriteCollab), observed commit `26710cbafd1df058d576e55fca80a2a73d64d356`.
- Red source: [pret/pokefirered](https://github.com/pret/pokefirered), observed commit `037335f4c725d7c9aecdac87066f2002b4bd7e14`.
- Download date: 14 October 2026.
- Scope: local prototype. The Pokémon walking/idle images are credited `CHUNSOFT` in upstream credits; Red is an original FireRed asset hosted in a decompilation repository. These files must not be described as newly generated or original project artwork.

### Source conditions and credits

PMDCollab's [README policy](https://github.com/PMDCollab/SpriteCollab/blob/26710cbafd1df058d576e55fca80a2a73d64d356/README.md) applies CC BY-NC 4.0 to submitted work with attribution. Its policy separately states that it preserves official Chunsoft sprites. Every selected Walk and Idle animation is credited to CHUNSOFT. The repository license does not itself establish permission from all owners of those original game assets.

The exact PMDCollab README, license, contributor-name mapping and per-character credits are included under `public/assets/sprites/`. Gengar's credits also include a community contributor for other animations; those other animations were not downloaded.

pret/pokefirered identifies itself as a decompilation of Pokémon FireRed/LeafGreen and provides no root reuse license. Its upstream README is preserved under `public/assets/sprites/red/UPSTREAM-README.md`. Original game attribution is Game Freak / Nintendo / The Pokémon Company; pret is the hosting decompilation project. This prototype's source notes do not confer redistribution or commercial rights.

### Verified dimensions and timing

PMDCollab sheets contain one animation frame per column and eight directions per row: **down, down-right, right, up-right, up, up-left, left, down-left**. This ordering is defined by the upstream [SpriteBot Constants.py](https://github.com/PMDCollab/SpriteBot/blob/master/Constants.py). Cardinal rows are down 0, right 2, up 4, left 6.

| Character | Animation | Sheet size | Frame size | Frames | Duration in ms per frame |
| --- | --- | --- | --- | --- | --- |
| Pikachu | Walk | 128 × 320 | 32 × 40 | 4 | 160, 200, 160, 200 |
| Pikachu | Idle | 240 × 448 | 40 × 56 | 6 | 800, 40, 60, 60, 60, 40 |
| Bulbasaur | Walk | 240 × 320 | 40 × 40 | 6 | 80, 80, 80, 80, 80, 80 |
| Bulbasaur | Idle | 96 × 320 | 32 × 40 | 3 | 800, 120, 120 |
| Squirtle | Walk | 128 × 256 | 32 × 32 | 4 | 240, 160, 240, 160 |
| Squirtle | Idle | 256 × 256 | 32 × 32 | 8 | 600, 40, 40, 80, 80, 80, 40, 40 |
| Gengar | Walk | 128 × 320 | 32 × 40 | 4 | 160, 200, 160, 200 |
| Gengar | Idle | 256 × 320 | 32 × 40 | 8 | 800, 80, 60, 60, 60, 60, 60, 80 |

Timing uses the same conversion as [SpriteBot's GIF export](https://github.com/PMDCollab/SpriteBot/blob/master/SpriteUtils.py): each `AnimData.xml` duration multiplied by 20 ms. This is a deliberate preview-playback convention, not a claim about every original game's frame rate.

All eight Pokémon PNGs are RGBA and contain alpha values from 0 through 255. Their frame dimensions and counts were verified against the source XML. Original `Walk-Shadow.png` and `Idle-Shadow.png` guide images are also preserved. Each frame's unique white marker was read to obtain its ground anchor. The manifest uses a shared anchor when constant and a per-direction `anchors` array where needed. This avoids inventing anchors from image dimensions and preserves source animation offsets.

Red uses a 144 × 32 indexed PNG with transparent palette index 0 and nine 16 × 32 cells in one row. Its first nine frame mappings and walking sequences were confirmed against the upstream [picture table](https://github.com/pret/pokefirered/blob/037335f4c725d7c9aecdac87066f2002b4bd7e14/src/data/object_events/object_event_pic_tables.h), [animation commands](https://github.com/pret/pokefirered/blob/037335f4c725d7c9aecdac87066f2002b4bd7e14/src/data/object_events/object_event_anims.h), and [graphics dimensions](https://github.com/pret/pokefirered/blob/037335f4c725d7c9aecdac87066f2002b4bd7e14/src/data/object_events/object_event_graphics_info.h):

- Idle down: frame 0. Up: frame 1. Left: frame 2. Right: frame 2 flipped horizontally.
- Walk down: 3, 0, 4, 0. Up: 5, 1, 6, 1. Left: 7, 2, 8, 2. Right: the left sequence flipped horizontally.
- Each walk pose lasts eight native ticks, represented as 8 × 1000/60 ms for this player.
- Red has no diagonal views in this pack; diagonal movement uses the corresponding left/right pose.

### Manifest consumption

Each `characters[species].animations[mode]` has the image path, sheet dimensions, frame dimensions, duration array, default ground anchor, SHA-256 and directional sequences.

Choose a sequence index from elapsed time and `durationMs`. Look up `direction.frames[index]` for the source column; the source row is `direction.row`. An optional `direction.flipX` reflects the drawn sprite. An optional `direction.anchors[index]` replaces the animation's default `anchor`.

The local source cell rectangle is:

```js
const sx = direction.frames[index] * animation.frameWidth;
const sy = direction.row * animation.frameHeight;
const anchor = direction.anchors?.[index] ?? animation.anchor;
```

Position that anchor at the character's world position. Use integer pixel scaling and disable image smoothing. Do not draw the shadow guide files as sprites: they are alignment data.

The pack now also includes Sit, Attack, Swing, Pose, Hurt, and Nod for all four Pokémon. These are unchanged PNGs from the same pinned SpriteCollab revision. Dedicated work and leisure routines combine those source poses with canvas-native tools, seats, papers, targets, and a fishing rod. No generated character art or raster edits were used. Run `node scripts/index-action-sprites.mjs` to rebuild their manifest entries from the saved XML and shadow guides; durations retain the same 20 ms conversion and every frame retains its measured ground anchor. The player still uses the original walking/idle sheets for travel, dialogue, and portraits.

## Pixel font

- File: `public/assets/fonts/PixelifySans.ttf`.
- Family: **Pixelify Sans**; normal style; variable weight 400–700.
- Source: [google/fonts, ofl/pixelifysans](https://github.com/google/fonts/tree/e9678a5385322c63730122ba464765baad83cfd8/ofl/pixelifysans).
- Designer: Stefie Justprince.
- Copyright: 2021 The Pixelify Sans Project Authors.
- License: SIL Open Font License 1.1, preserved as `public/assets/fonts/PixelifySans-OFL.txt`.
- Upstream metadata and source information are preserved beside the font. The font bytes are unchanged; only the filename was shortened from `PixelifySans[wght].ttf`.

Browser registration:

```css
@font-face {
  font-family: "Pixelify Sans";
  src: url("/assets/fonts/PixelifySans.ttf") format("truetype");
  font-style: normal;
  font-weight: 400 700;
  font-display: swap;
}
```

For a native Canvas implementation, register the same TTF path with family name `Pixelify Sans`.


## Village v3: waiting and rest

The v3 background is `public/assets/village-v3.png`, an edit made with the built-in Image Generation tool. It adds Guild waiting props, a campfire, Town Hall, Trial Arena, and Harbor. See [v3 prompt and provenance](village-v3-art.md). Older compiled replays retain their original map assets. The boat, status badges, and waiting links are canvas-native drawing code in `src/effects.mjs`.


## Twelve-species cast

The roster now adds Charmander (0004), Vulpix (0037), Jigglypuff (0039), Meowth (0052), Psyduck (0054), Growlithe (0058), Eevee (0133), and Snorlax (0143). All files come from the same pinned SpriteCollab revision `26710cbafd1df058d576e55fca80a2a73d64d356`; the manifest includes an exact source URL for each species. Original PNG bytes, XML timing, and shadow anchors are retained. No sprite images were generated or edited.

Each new folder preserves its upstream credits. Downloaded animations are credited to CHUNSOFT except Jigglypuff's Pose, Nod, and Sit, credited to **JFain** under CC BY-NC 4.0. The bundled contributor mapping resolves `<@!702275233125630042>` to JFain. Existing source-condition notes above still apply.

`node scripts/index-action-sprites.mjs` now indexes Walk, Idle, and available Sit, Attack, Swing, Pose, Hurt, and Nod for every Pokémon. There are 88 Pokémon animation entries across twelve species, plus Red's original two entries. Psyduck lacks Sit and Nod; Snorlax and Growlithe lack Sit, Nod, and Pose in this revision. The renderer uses their idle frames for those missing poses while keeping canvas-drawn activity props and status indicators. It does not invent replacement source animations.

New timelines store species IDs directly. Legacy role aliases continue to render. Cast assignment uses stable actor/session keys, balances the available roster, and preserves assigned species when composing sessions. There is no random choice during playback. Reopening an unchanged replay reproduces its cast; adding actors to an uncompiled source can rebalance assignments.

In a multi-session view, a single Red trainer is a display representative of the human. Original source user actors and events are retained separately. Selecting an original human event keeps its exact session attribution, while selecting the shared trainer can show human messages across the current session scope.


## Village v4: the Inn

`public/assets/village-v4.png` is an Image Generation edit of v3, saved unchanged from the generated PNG. It adds a small burgundy-roof Inn beside the southern road, below the Arena. Earlier landmarks and the crooked paths remain in place. The authored entry is at normalized coordinates (0.86, 0.935). Older timeline asset versions keep their original backgrounds. Fireworks and the colored boat flag are deterministic canvas drawing code, not additional raster assets.

Generation prompt:

> Edit this exact village background for a deterministic game. Preserve the square overhead pixel-art style, every existing building and its sign, all existing paths, camp, bridge, water and coastline in their exact positions. Make ONE small local addition: a cozy small INN in the lower-right corner, on the land to the right of the winding southern road and BELOW the Trial Arena. Replace only a patch of lower-right forest/rocks with the new inn. Place its front doorstep approximately at normalized x=.86 y=.91 (86% across, 91% down); keep the entire building between x=.79-.98 and y=.79-.93, away from the Arena above. Inn has a small burgundy crooked tiled roof, warm lit windows, a bed emblem, readable sign 'INN', and a short sandy footpath connecting its door to the existing southern road around x=.75 y=.92. It should be smaller than the Depot, cozy and clearly distinct. No characters, no UI, no fireworks, no extra boats. Keep every other area unchanged; maintain precise landmark locations and no rescaling/cropping. Production game background, opaque square PNG.
