# Desktop themes

In the new desktop interface, open **Settings → Appearance → Theme**:

| Theme | Palette |
| --- | --- |
| Rex (default) | Neutral charcoal, near-black sidebar, muted blue selection and lavender accent; inspired by Rex, not an exact terminal theme import. |
| Slate | Cool graphite and blue. |
| Ember | Warm charcoal and copper. |
| Paper | Ivory and ink in light mode; warm neutral surfaces in dark mode. |

**Color scheme** is separate: System follows macOS; Light and Dark are fixed.
Every palette supports both. Changing themes does not change the color-scheme
preference, restart connections, or discard open work. Selection is saved on this
Mac, not on a daemon or profile. Preview and production apps keep separate defaults.

Themes style the redesigned workspace, shared dialogs, rendered Markdown, and the
terminal's default/ANSI colors. Terminal changes apply in place without clearing
scrollback. Explicit RGB colors emitted by terminal applications, screenshots,
syntax/diff meaning, chart categories, and Village scene art are not recolored.
Semantic success/warning/error colors remain distinct from decorative accents.

The legacy interface retains its native styling and System/Light/Dark control.
Enable **New desktop interface** in Appearance to choose a workspace palette. The
last selected palette is retained when switching interfaces; shared Markdown and
terminal content still use it.

## Development

- `DesktopPalette.swift`: immutable light/dark values, ANSI colors, persisted
  `DesktopThemePreferences` selection (`autopod.desktop.theme`; missing/unknown
  values fall back to Rex).
- `DesktopTheme.swift`: existing token API, backed by an observable preference.
  Read tokens during view evaluation so SwiftUI tracks live changes. Do not cache
  a selected theme's colors in static stored values or reset views with `.id(theme)`.
- `DesktopThemePreviewCard.swift`: each preview renders its own candidate palette.
- `TerminalEmulatorView.swift`: recolors the existing SwiftTerm view only when the
  resolved palette changes; font, data pipe, delegate and terminal buffer survive.

Native checks:

```sh
swift test --package-path packages/desktop --no-parallel --filter DesktopThemeTests
swift test --package-path packages/desktop --no-parallel --filter desktopThemeWorkspace
./scripts/test-desktop.sh
```

Set `AUTOPOD_THEME_SNAPSHOTS=/absolute/output/directory` on the theme checks to save
native settings and fixture-workspace screenshots. Tests cover preference
persistence/fallback, color-scheme independence, text/status/ANSI contrast, actual
picker activation and live native rendering, and terminal identity, scrollback,
input forwarding and light/dark updates without contacting a daemon.
