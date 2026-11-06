"""Render the editorial Why Autopod / How it works board, not a UI screenshot.

Usage: python3 assets/readme/features.py
Requires Pillow and the same macOS Arial fonts used by compose.py.
Claims map to the README's linked profile, CLI, validation, and mobile guides.
No performance numbers, successful runs, or security guarantees are invented.
"""

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

OUTPUT = Path(__file__).resolve().parent / "features.png"
WIDTH, HEIGHT = 1624, 1256
INK, MUTED, ACCENT = "#eef0f8", "#a6aabd", "#b8a6ef"
FONT = "/System/Library/Fonts/Supplemental/Arial.ttf"
BOLD = "/System/Library/Fonts/Supplemental/Arial Bold.ttf"
image = Image.new("RGB", (WIDTH, HEIGHT))
draw = ImageDraw.Draw(image)
for y in range(HEIGHT):
    t = y / HEIGHT
    draw.line((0, y, WIDTH, y), fill=(int(25 - 13 * t), int(24 - 9 * t), int(43 - 19 * t)))


def text(x, y, copy, size, fill=INK, bold=False, leading=1.35):
    face = ImageFont.truetype(BOLD if bold else FONT, size)
    for line in copy.split("\n"):
        # Fail rather than silently crop text after a copy/font change.
        if draw.textbbox((x, y), line, font=face)[2] > WIDTH - 48:
            raise ValueError(f"Text exceeds artboard: {line}")
        draw.text((x, y), line, font=face, fill=fill)
        y += round(size * leading)


def line(points, fill=ACCENT, width=3):
    draw.line(points, fill=fill, width=width, joint="curve")


def arrow(x, y, right=True, fill=ACCENT):
    direction = 1 if right else -1
    line([(x - direction * 10, y - 6), (x, y), (x - direction * 10, y + 6)], fill, 2)


def icon(kind, x, y):
    if kind == "fleet":
        for dx, dy in [(0, 10), (10, 0), (20, 10)]:
            draw.rounded_rectangle((x + dx, y + dy, x + dx + 14, y + dy + 21), 3, outline=ACCENT, width=2)
    elif kind == "proof":
        line([(x + 17, y), (x + 31, y + 6), (x + 29, y + 22), (x + 17, y + 32), (x + 5, y + 22), (x + 3, y + 6), (x + 17, y)])
        line([(x + 10, y + 15), (x + 15, y + 20), (x + 24, y + 10)], width=2)
    elif kind == "retry":
        draw.arc((x + 2, y + 1, x + 32, y + 31), 30, 190, fill=ACCENT, width=3)
        draw.arc((x + 2, y + 1, x + 32, y + 31), 210, 370, fill=ACCENT, width=3)
        line([(x + 1, y + 8), (x + 2, y + 18), (x + 11, y + 15)], width=2)
        line([(x + 23, y + 17), (x + 32, y + 14), (x + 33, y + 24)], width=2)
    elif kind == "models":
        line([(x + 11, y + 3), (x + 1, y + 15), (x + 11, y + 27)])
        line([(x + 25, y + 3), (x + 35, y + 15), (x + 25, y + 27)])
        line([(x + 21, y), (x + 15, y + 31)], width=2)
    elif kind == "workflow":
        for dx, dy in [(0, 0), (24, 12), (0, 24)]:
            draw.rounded_rectangle((x + dx, y + dy, x + dx + 10, y + dy + 9), 2, outline=ACCENT, width=2)
        line([(x + 10, y + 4), (x + 17, y + 4), (x + 17, y + 16), (x + 24, y + 16)], width=2)
        line([(x + 10, y + 28), (x + 17, y + 28), (x + 17, y + 16)], width=2)
    elif kind == "control":
        for dx, knob in [(3, 10), (17, 23), (31, 6)]:
            line([(x + dx, y), (x + dx, y + 32)], width=2)
            draw.ellipse((x + dx - 4, y + knob - 4, x + dx + 4, y + knob + 4), fill="#211e33", outline=ACCENT, width=2)


text(52, 32, "AUTOPOD  /  WHY & HOW", 18, bold=True)
text(1340, 35, "PRODUCT OVERVIEW", 14, MUTED)
text(52, 97, "More work in flight.", 57, bold=True)
text(52, 168, "Less work on your plate.", 57, bold=True)
text(52, 248, "The environment, the checks, the feedback loops. Not just the agent.", 25, MUTED)

cards = [
    ("fleet", "PARALLEL AGENTS", "A fleet. Not more tabs.", "Run isolated tasks across repos.\nSee progress, costs, and blockers\nin one workspace."),
    ("proof", "INDEPENDENT VALIDATION", "Proof beyond \u201cdone\u201d.", "Configured build and test checks.\nDiffs, browser evidence for web apps,\nand a separate AI task review."),
    ("retry", "FEEDBACK LOOPS", "Give it another pass.", "Failed required checks feed back\ninto another attempt\nwithin your retry limits."),
    ("models", "YOUR MODELS. YOUR STACK.", "Keep your options open.", "Claude, Codex, or Copilot.\nLocal Docker or Azure Sandboxes.\nGitHub or Azure DevOps PRs."),
    ("workflow", "BEYOND ONE-OFF TASKS", "Make it a workflow.", "Chain dependent pods into a series.\nSchedule recurring work. Reuse\nrepository profiles and templates."),
    ("control", "HUMAN CONTROL", "Stay in the driver's seat.", "Answer questions. Pause or nudge.\nInspect readiness on desktop.\nApprove or reject from your phone."),
]
for index, (kind, eyebrow, title, body) in enumerate(cards):
    x = 52 + (index % 3) * 512
    y = 318 + (index // 3) * 242
    draw.rounded_rectangle((x, y, x + 496, y + 224), 16, fill="#171923", outline="#383546", width=1)
    icon(kind, x + 24, y + 23)
    text(x + 74, y + 33, eyebrow, 15, ACCENT, True)
    text(x + 24, y + 78, title, 28, bold=True)
    # Bound copy to its own card, not just the outer artboard.
    body_font = ImageFont.truetype(FONT, 23)
    for row in body.split("\n"):
        if draw.textlength(row, font=body_font) > 446:
            raise ValueError(f"Text exceeds feature card: {row}")
    text(x + 24, y + 126, body, 23, MUTED, leading=1.35)

line([(52, 835), (1572, 835)], fill="#383546", width=1)
text(52, 872, "HOW IT WORKS", 17, ACCENT, True)
text(52, 908, "From a task to a reviewable result.", 36, bold=True)
steps = [
    ("01", "Describe", "Task + repository"),
    ("02", "Run", "Isolated agent"),
    ("03", "Verify", "Configured checks"),
    ("04", "Decide", "Readiness + policy"),
    ("05", "Deliver", "PRs or artifacts"),
]
for index, (number, title, subtitle) in enumerate(steps):
    x = 52 + index * 308
    draw.rounded_rectangle((x, 978, x + 288, 1097), 12, fill="#171923", outline="#484056", width=1)
    text(x + 18, 992, number, 16, ACCENT, True)
    text(x + 18, 1018, title, 28, bold=True)
    text(x + 18, 1060, subtitle, 21, MUTED)
    if index < 4:
        line([(x + 292, 1037), (x + 304, 1037)], width=2)
        arrow(x + 304, 1037)

# Show the retry loop explicitly; success is not implied by the straight-line flow.
line([(812, 1107), (812, 1130), (504, 1130), (504, 1107)], fill="#8876b0", width=2)
line([(498, 1115), (504, 1107), (510, 1115)], fill="#8876b0", width=2)
text(52, 1160, "Failed required checks feed the next attempt. Retry limits and delivery policy still apply.", 22, MUTED)
text(52, 1206, "Checks depend on configuration. Optional advisory browser QA is not a blocking gate.", 19, MUTED)

image.save(OUTPUT, optimize=True)
print(f"{OUTPUT.name}: {WIDTH}×{HEIGHT}, {OUTPUT.stat().st_size / 1024:.0f} KiB")
