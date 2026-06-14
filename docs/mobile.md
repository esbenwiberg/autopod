# Mobile Control (PWA)

A lightweight phone-side companion that reaches the laptop's daemon over
Tailscale. Think Codex mobile: see the "needs me" inbox, answer escalations,
approve / reject / kill / nudge from your phone without opening the desktop
app.

> **Status**: usable operator companion. Pairing, live WebSocket updates,
> needs-me/active inboxes, pod creation, pod details, escalation replies,
> validation summaries, recent activity, and approve / reject / kill / nudge
> actions are implemented.

## What it can do

- Show a **Needs me** inbox for pods awaiting input, review, or operator action.
- Show active pods with live status updates over `/events`.
- Create a new pod from a selected profile and task text.
- Open pod details with progress, plan, task markdown, validation history, and
  recent activity.
- Answer pending escalations from the phone.
- Run available pod actions: approve, reject, kill, nudge, pause/resume where
  the pod state allows it.
- Toggle skip-validation for eligible pods.
- Show daemon health, token status, and re-pair affordances.

## Build / serving path

The app lives in `packages/mobile-web` and builds with Vite:

```bash
npx pnpm --filter @autopod/mobile-web build
```

The daemon serves `packages/mobile-web/dist` at `/mobile/*` when the bundle is
present. `npx pnpm dev` builds the mobile bundle before starting workspace dev
tasks, and the production Dockerfile copies the built bundle into the daemon
image. Static `/mobile/*` files are public; API/WebSocket calls still require
the paired bearer token.

## Prerequisites

1. **Tailscale** installed and signed in on both the laptop and the phone, on
   the same tailnet.
2. **Dev auth enabled** on the daemon — set `AUTOPOD_ALLOW_DEV_AUTH=1` when
   you start the daemon. On first run it generates a random 32-byte token at
   `~/.autopod/dev-token` (chmod 600). This is what the phone uses to talk to
   the daemon.
3. **Daemon reachable on the laptop at `127.0.0.1:3100`**. The daemon binary
   defaults to loopback; Docker Compose runs the daemon with `HOST=0.0.0.0`
   inside the container but still publishes the host port locally. Public
   phone exposure should go through `tailscale serve`, not a raw internet
   listener.

## One-time setup

Expose the daemon over Tailscale Serve. Tailscale handles the HTTPS cert
automatically via its tailnet CA — required for iOS to install the page as a
PWA and to run a service worker.

```bash
tailscale serve --bg --https=443 http://127.0.0.1:3100
```

Verify from your phone (on the tailnet):

```
https://<your-tailnet-hostname>/health   # expect {"status":"ok",...}
```

`ap mobile serve-instructions` prints this snippet with your detected
hostname pre-filled.

## Pairing the phone

```bash
ap mobile pair
```

This:

1. Reads `~/.autopod/dev-token`.
2. Resolves your tailnet hostname (e.g. `mymac.tail1234.ts.net`) via
   `tailscale status --json`. Cached to `~/.autopod/config.yaml` on first
   success; pass `--host <name>` to override.
3. Renders a terminal QR code containing
   `https://<host>/mobile/#/pair?token=<hex>`.

Scan the QR with your phone's camera. iOS Safari / Android Chrome opens the
URL, the PWA loads, reads the token from the URL fragment, persists it to
`localStorage`, and scrubs the URL.

**Why fragment, not query?** URL fragments are never sent to servers, so the
token doesn't appear in Tailscale's reverse-proxy logs or the daemon's
request logs. After the PWA scrubs it, the token also doesn't sit in browser
history.

## Installing to home screen

iOS Safari: `Share → Add to Home Screen`. The PWA launches in standalone
mode (no Safari chrome) with the Autopod icon.

Android Chrome: prompts automatically after a couple of visits, or
`⋮ menu → Install app`.

## Troubleshooting

- **"No dev token at ~/.autopod/dev-token"** — start the daemon once with
  `AUTOPOD_ALLOW_DEV_AUTH=1` to generate it, then re-run `ap mobile pair`.
- **QR scan opens a "Safari can't connect" page** — `tailscale serve` hasn't
  been set up, or the laptop is offline / sleeping. Run
  `tailscale serve status` to verify.
- **"This Connection is Not Private" / cert warning** — Tailscale Serve issues
  certs from its CA, valid for any device in the tailnet. Make sure the phone
  is signed into the *same* tailnet as the laptop.
- **Token rotation** — delete `~/.autopod/dev-token`, restart the daemon (it
  generates a fresh one), then re-run `ap mobile pair`. The phone's stored
  token is now stale; the PWA will redirect to a "re-pair" screen on the
  next failed call.
- **Hostname changed** — `ap mobile pair --host <new-host>` to override the
  cached value.

## Security model

- The phone path is exposed through Tailscale Serve. Avoid publishing the daemon
  directly to the internet; when running outside Compose, prefer the daemon's
  loopback default.
- Tailscale ACLs gate which devices on the tailnet can reach the laptop.
  Scope them to just your phone's node if you want belt-and-braces.
- The dev token is a 32-byte pre-shared key — strong against brute force,
  but treat it like a password (don't commit it, don't screenshot it).
- `/mobile/*` is unauthenticated by design. The static bundle contains no
  secrets; the SPA enforces auth on every REST + WebSocket call using the
  token from `localStorage`. All other daemon routes still require the
  Bearer token.
