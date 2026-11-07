"""Frame real native captures and assemble a captioned still-frame UI tour.

Usage: python3 assets/readme/compose.py /absolute/path/to/raw-captures
Requires Pillow. No screenshot contents, statuses, or metrics are synthesized.
"""

import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

OUTPUT = Path(__file__).resolve().parent
RAW = Path(sys.argv[1])
FONT = "/System/Library/Fonts/Supplemental/Arial.ttf"
BOLD = "/System/Library/Fonts/Supplemental/Arial Bold.ttf"
INK, MUTED, ACCENT = "#eef0f8", "#a6aabd", "#b8a6ef"


def font(size, bold=False):
    return ImageFont.truetype(BOLD if bold else FONT, size)


def canvas(width, height):
    image = Image.new("RGB", (width, height))
    draw = ImageDraw.Draw(image)
    for y in range(height):
        t = y / height
        draw.line((0, y, width, y), fill=(int(25 - 13 * t), int(24 - 9 * t), int(43 - 19 * t)))
    return image


def shot(name):
    image = Image.open(RAW / f"{name}.png").convert("RGB")
    # NSHostingView includes a 16-point empty inset above and below its fixed frame.
    if image.size != (1560, 972):
        raise ValueError(f"Recheck crop for changed native capture dimensions: {image.size}")
    return image.crop((0, 16, 1560, 956))


def panel(image, content, xy, radius=12):
    mask = Image.new("L", content.size)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, content.width - 1, content.height - 1), radius, fill=255)
    image.paste(content, xy, mask)
    x, y = xy
    ImageDraw.Draw(image).rounded_rectangle(
        (x, y, x + content.width - 1, y + content.height - 1), radius, outline="#414052", width=1
    )


def lines(draw, xy, text, size, fill=INK, bold=False, leading=1.3):
    x, y = xy
    for line in text.split("\n"):
        draw.text((x, y), line, font=font(size, bold), fill=fill)
        y += round(size * leading)


hero = canvas(1624, 1044)
h = ImageDraw.Draw(hero)
h.ellipse((32, 27, 41, 36), fill=ACCENT)
h.text((52, 21), "AUTOPOD  /  AGENT WORKSPACE", font=font(17, True), fill=INK)
h.text((1324, 23), "OFFLINE SAMPLE DATA", font=font(14), fill=MUTED)
panel(hero, shot("desktop"), (32, 64))
hero.save(OUTPUT / "desktop.png", optimize=True)

stages = [
    ("desktop", "Your fleet.\nOne workspace.", "See tasks across repositories,\nmodels, and stages at a glance.", "01  /  FLEET OVERVIEW"),
    ("work", "Know what\nchanged.", "Read the reported summary.\nInspect deviations and costs.\nThen check the evidence.", "02  /  REPORTED WORK"),
    ("readiness", "A pass isn't\nthe whole story.", "Surface compatibility warnings\nand missing evidence before\ndeciding what ships.", "03  /  READINESS REVIEW"),
    ("diff", "Get down\nto the diff.", "Inspect the actual code change.\nApprove or request another\niteration when you're ready.", "04  /  CODE REVIEW"),
]
frames = []
for index, (name, title, body, chapter) in enumerate(stages):
    frame = canvas(1280, 800)
    draw = ImageDraw.Draw(frame)
    draw.text((36, 30), "AUTOPOD", font=font(18, True), fill=INK)
    draw.text((1043, 33), "OFFLINE SAMPLE DATA", font=font(13), fill=MUTED)
    lines(draw, (36, 138), chapter, 14, ACCENT, True)
    lines(draw, (36, 185), title, 39, bold=True)
    lines(draw, (36, 325), body, 18, MUTED, leading=1.6)
    lines(draw, (36, 669), "Real native UI. Sample data.\nNot a live agent execution.", 14, MUTED, leading=1.5)
    for dot in range(4):
        x = 36 + dot * 40
        draw.rounded_rectangle((x, 740, x + 28, 743), 2, fill=ACCENT if dot == index else "#464354")
    if name == "desktop":
        content = shot(name).resize((840, 506), Image.Resampling.LANCZOS)
        panel(frame, content, (408, 142))
    else:
        # A readable close-up of the real detail panel; no UI content is replaced.
        content = shot(name).crop((1021, 0, 1560, 740))
        content = content.resize((485, 666), Image.Resampling.LANCZOS)
        panel(frame, content, (645, 81))
    frames.append(frame)

# A static alternative for the readiness chapter, with the same visible disclosure.
frames[2].save(OUTPUT / "readiness.png", optimize=True)

# Use one shared palette so the native UI doesn't flicker between chapters.
swatches = Image.new("RGB", (1280, 800 * len(frames)))
for index, frame in enumerate(frames):
    swatches.paste(frame, (0, index * 800))
palette = swatches.quantize(colors=256, method=Image.Quantize.MEDIANCUT)
animation, durations = [], []
for index, frame in enumerate(frames):
    animation.append(frame.quantize(palette=palette, dither=Image.Dither.NONE))
    durations.append(3400)
    following = frames[(index + 1) % len(frames)]
    for step in range(1, 5):
        transition = Image.blend(frame, following, step / 5)
        animation.append(transition.quantize(palette=palette, dither=Image.Dither.NONE))
        durations.append(60)
animation[0].save(
    OUTPUT / "tour.gif", save_all=True, append_images=animation[1:],
    duration=durations, loop=0, optimize=True, disposal=1,
)
for name in ("desktop.png", "readiness.png", "tour.gif"):
    path = OUTPUT / name
    print(f"{name}: {path.stat().st_size / 1024:.0f} KiB")
