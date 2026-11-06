"""Render an editorial, source-checked security-boundaries board.

Usage: python3 assets/readme/security.py
Requires Pillow and macOS Arial fonts, as with the other README graphics.
See docs/security-overview.md for scope, configuration, exceptions, and sources.
This is not a screenshot, security certification, or claim of complete protection.
"""

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

OUTPUT = Path(__file__).resolve().parent / "security.png"
WIDTH, HEIGHT = 1624, 1032
INK, MUTED, ACCENT = "#eef0f8", "#a6aabd", "#b8a6ef"
FONT = "/System/Library/Fonts/Supplemental/Arial.ttf"
BOLD = "/System/Library/Fonts/Supplemental/Arial Bold.ttf"
image = Image.new("RGB", (WIDTH, HEIGHT))
draw = ImageDraw.Draw(image)
for y in range(HEIGHT):
    t = y / HEIGHT
    draw.line((0, y, WIDTH, y), fill=(int(25 - 13 * t), int(24 - 9 * t), int(43 - 19 * t)))


def text(x, y, copy, size, fill=INK, bold=False, leading=1.4, max_width=None):
    face = ImageFont.truetype(BOLD if bold else FONT, size)
    for row in copy.split("\n"):
        limit = max_width if max_width is not None else WIDTH - x - 48
        if draw.textlength(row, font=face) > limit:
            raise ValueError(f"Text exceeds its panel: {row}")
        draw.text((x, y), row, font=face, fill=fill)
        y += round(size * leading)


def card(x, y, height):
    draw.rounded_rectangle((x, y, x + 496, y + height), 16,
                           fill="#171923", outline="#383546", width=1)


text(52, 32, "AUTOPOD  /  SECURITY BOUNDARIES", 18, bold=True)
text(1340, 35, "PRODUCT OVERVIEW", 14, MUTED)
text(52, 97, "Useful access.", 57, bold=True)
text(52, 168, "Deliberate boundaries.", 57, bold=True)
text(52, 248, "Network policy, scoped tools, filtered content, and evidence. Not trust in a prompt.", 25, MUTED)

for x in (52, 564, 1076):
    card(x, 318, 350)

text(76, 344, "01  /  WORKER EGRESS", 15, ACCENT, True, max_width=448)
text(76, 387, "Choose the destinations.", 28, bold=True, max_width=448)
for y, mode, description in [
    (443, "allow-all", "Open outbound"),
    (488, "deny-all", "Exceptions only*"),
    (533, "restricted", "Hostname allowlist*"),
]:
    text(76, y, mode, 22, ACCENT, True, max_width=142)
    text(236, y, description, 22, max_width=286)
text(76, 597, "*Enable policy; target-specific DNS,\ndaemon and sidecar exceptions apply.", 20, MUTED, max_width=448)

text(588, 344, "02  /  BROKERED ACTIONS", 15, ACCENT, True, max_width=448)
text(588, 387, "Gate requests, not intent.", 28, bold=True, max_width=448)
text(588, 443, "Enabled action groups\nValidated request parameters\nOptional resource allowlists\nApproval where configured", 24, max_width=448)
text(588, 597, "The daemon resolves credentials\nfor its action handlers.", 20, MUTED, max_width=448)

text(1100, 344, "03  /  UNTRUSTED RESPONSES", 15, ACCENT, True, max_width=448)
text(1100, 387, "Filter what comes back.", 28, bold=True, max_width=448)
text(1100, 443, "Prompt-injection scoring\nQuarantine / block by score\nPII and secret-pattern redaction\nAction response-field selection", 24, max_width=448)
text(1100, 597, "Configured action-response filters.\nNot inspection of every network byte.", 20, MUTED, max_width=448)

supports = [
    (52, "Encrypted at rest", "Stored profile secrets: AES-256-GCM.\nAction auth is resolved daemon-side.\nWorkers can receive runtime tokens."),
    (564, "Pod-scoped access", "Expiring HMAC tokens for MCP.\nProduction clients use Entra ID.\nKeep the daemon in a trusted boundary."),
    (1076, "Evidence you can inspect", "Hash-chained action audit.\nEgress-denial and filter findings.\nRisk signals in Readiness Review."),
]
for x, title, body in supports:
    card(x, 694, 179)
    text(x + 24, 717, title, 27, bold=True, max_width=448)
    text(x + 24, 765, body, 22, MUTED, max_width=448)

draw.line((52, 910, 1572, 910), fill="#383546", width=1)
text(52, 937, "Defense in depth. Not immunity to prompt injection.", 29, bold=True)
text(52, 986, "Allowed tools and destinations can still move data. Scope policies; protect the host.", 22, MUTED)
image.save(OUTPUT, optimize=True)
print(f"{OUTPUT.name}: {WIDTH}×{HEIGHT}, {OUTPUT.stat().st_size / 1024:.0f} KiB")
