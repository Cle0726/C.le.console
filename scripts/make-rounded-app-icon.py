"""Create a lossless, antialiased rounded-square app icon from the painted cat artwork."""

from pathlib import Path
from PIL import Image, ImageDraw


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "src" / "assets" / "app-icon.png"
OUTPUT = ROOT / "src" / "assets" / "app-icon-rounded.png"


def main() -> None:
    image = Image.open(SOURCE).convert("RGBA")
    width, height = image.size
    scale = 4
    radius = round(min(width, height) * 0.18 * scale)
    mask = Image.new("L", (width * scale, height * scale), 0)
    draw = ImageDraw.Draw(mask)
    draw.rounded_rectangle(
        (0, 0, width * scale - 1, height * scale - 1),
        radius=radius,
        fill=255,
    )
    mask = mask.resize((width, height), Image.Resampling.LANCZOS)
    image.putalpha(mask)
    image.save(OUTPUT, optimize=True)
    print(f"Created {OUTPUT} ({width}x{height}, radius={radius // scale}px)")


if __name__ == "__main__":
    main()
