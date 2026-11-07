"""Render the dedicated Action Control Plane explainer, not a UI screenshot.

Usage: python3 assets/readme/acp.py
Requires Pillow and macOS Arial fonts. Claims and implementation references:
docs/security-overview.md#brokered-tools-not-ambient-authority
No daemon, cloud services, or PIM activations are invoked.
"""

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

OUTPUT = Path(__file__).resolve().parent / "acp.png"
WIDTH, HEIGHT = 1624, 1104
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


def panel(bounds, highlight=False):
    draw.rounded_rectangle(bounds, 14, fill="#171923",
                           outline="#75638f" if highlight else "#383546", width=1)


def arrow(x, y, right=True):
    direction = 1 if right else -1
    draw.line([(x - direction * 9, y - 6), (x, y), (x - direction * 9, y + 6)],
              fill=ACCENT, width=2, joint="curve")


text(52, 32, "AUTOPOD  /  ACTION CONTROL PLANE", 18, bold=True)
text(1340, 35, "PRODUCT OVERVIEW", 14, MUTED)
text(52, 97, "Ask for a capability.", 57, bold=True)
text(52, 168, "Not a credential.", 57, bold=True)
text(52, 248, "The pod makes a scoped request. The daemon checks policy and performs the operation.", 25, MUTED)
text(52, 306, "REQUEST  /  CHECK  /  EXECUTE  /  PROCESS  /  RETURN", 16, ACCENT, True)

steps = [
    ("01", "Agent request", "execute_action\nname + parameters"),
    ("02", "Policy gate", "Groups + resource limits\nApproval if required"),
    ("03", "Daemon handler", "Selected integration\nDaemon-side auth"),
    ("04", "Response controls", "Fields + content filters*\nPer action policy"),
    ("05", "Result to worker", "Data + outcome\nReturned to the agent"),
]
for index, (number, title, body) in enumerate(steps):
    x = 52 + index * 310
    panel((x, 344, x + 280, 500), highlight=index == 1)
    text(x + 20, 364, number, 16, ACCENT, True, max_width=240)
    text(x + 20, 395, title, 26, bold=True, max_width=240)
    text(x + 20, 441, body, 20, MUTED, max_width=240)
    if index < 4:
        draw.line((x + 285, 423, x + 305, 423), fill=ACCENT, width=2)
        arrow(x + 305, 423)

# A rejected/pending request does not reach the integration handler.
panel((52, 532, 412, 638))
text(76, 550, "Denied / needs approval", 24, bold=True, max_width=312)
text(76, 592, "No handler execution", 21, MUTED, max_width=312)
draw.line([(502, 500), (502, 585), (412, 585)], fill=ACCENT, width=2)
arrow(412, 585, right=False)

# Audit is execution evidence, not a promise to log every rejected request.
draw.line((812, 500, 812, 532), fill=ACCENT, width=2)
panel((672, 532, 1572, 638))
text(696, 549, "Hash-chained action audit", 26, bold=True, max_width=852)
text(696, 593, "Recorded execution outcomes. Not every pre-dispatch denial.", 21, MUTED, max_width=852)

text(52, 681, "REQUESTABLE CAPABILITIES  /  ONLY WHEN CONFIGURED", 16, ACCENT, True)
capabilities = [
    ("GitHub", "Read issues, PRs,\ncomments and code."),
    ("Azure DevOps", "Read work items,\nPRs and repository files."),
    ("Azure logs", "Query Log Analytics,\napp and container logs."),
    ("Azure PIM", "Request declared\ngroups / RBAC roles."),
    ("HTTP APIs", "Call configured\nAPI operations."),
]
for index, (title, body) in enumerate(capabilities):
    x = 52 + index * 310
    panel((x, 724, x + 280, 888))
    text(x + 20, 748, title, 26, bold=True, max_width=240)
    text(x + 20, 799, body, 21, MUTED, max_width=240)

draw.line((52, 932, 1572, 932), fill="#383546", width=1)
text(52, 959, "PIM is preconfigured. Approval is policy-driven.", 29, bold=True)
text(52, 1009, "Role/group choices, scopes and durations are constrained; eligibility and tenant policy still apply.", 22, MUTED)
text(52, 1053, "*Action-response filtering is configurable. This is not the separate remote-MCP proxy path.", 20, MUTED)
image.save(OUTPUT, optimize=True)
print(f"{OUTPUT.name}: {WIDTH}×{HEIGHT}, {OUTPUT.stat().st_size / 1024:.0f} KiB")
