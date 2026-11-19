#!/usr/bin/env python3
"""Build transparent-corner, upscaled desktop (ICO/PNG) and Android icons."""

from __future__ import annotations

import argparse
import math
import shutil
import sys
from collections import deque
from pathlib import Path
from PIL import Image, ImageFilter

DEFAULT_EXTERNAL_SOURCE = Path(r"F:\ダウンロード改\Gemini_Generated_Image_ky5cjrky5cjrky5c.jfif")
PROJECT_ROOT = Path(__file__).resolve().parent.parent
ICON_DIR = PROJECT_ROOT / "assets" / "icons"
BACKUP_SOURCE_PATH = ICON_DIR / "source_icon.jfif"
ANDROID_DIR = ICON_DIR / "android"
MASTER_ICON_PATH = ICON_DIR / "icon-master-1024.png"
APP_ICO_PATH = ICON_DIR / "app.ico"
APP_32_PNG_PATH = ICON_DIR / "app-32.png"
APP_48_PNG_PATH = ICON_DIR / "app-48.png"

MASTER_SIZE = 1024
DEFAULT_COLOR_TOLERANCE = 36
DEFAULT_EDGE_FEATHER = 28
ALPHA_CROP_THRESHOLD = 16
BOUNDARY_FILTER_SIZE = 5  # 5x5 MaxFilter covers 8-neighborhood distance 1..2 px
MIN_UNPREMULTIPLY_RATIO = 0.25
SMALL_ICON_SHARPEN_MAX_PX = 48

ICO_SIZES = [(16, 16), (24, 24), (32, 32), (40, 40), (48, 48), (64, 64), (128, 128), (256, 256)]

DESKTOP_PNG_TARGETS = [
    (APP_32_PNG_PATH.name, 32),
    (APP_48_PNG_PATH.name, 48),
    ("app-192.png", 192),
    ("app-256.png", 256),
]

ANDROID_FLAT_TARGETS = [
    ("icon-48-mdpi.png", 48),
    ("icon-72-hdpi.png", 72),
    ("icon-96-xhdpi.png", 96),
    ("icon-144-xxhdpi.png", 144),
    ("icon-192-xxxhdpi.png", 192),
    ("icon-512-playstore.png", 512),
]

ANDROID_MIPMAP_TARGETS = [
    ("res/mipmap-mdpi/ic_launcher.png", 48),
    ("res/mipmap-hdpi/ic_launcher.png", 72),
    ("res/mipmap-xhdpi/ic_launcher.png", 96),
    ("res/mipmap-xxhdpi/ic_launcher.png", 144),
    ("res/mipmap-xxxhdpi/ic_launcher.png", 192),
]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Remove outer background via BFS flood-fill, trim, upscale to 1024x1024, and generate icons."
    )
    parser.add_argument(
        "--source",
        type=Path,
        default=None,
        help="Optional path to source image. Defaults to local backup or external source.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print detected background, crop box, and output targets without writing files.",
    )
    parser.add_argument(
        "--tolerance",
        type=int,
        default=DEFAULT_COLOR_TOLERANCE,
        help=f"RGB Euclidean distance threshold for outer background (default: {DEFAULT_COLOR_TOLERANCE}).",
    )
    parser.add_argument(
        "--feather",
        type=int,
        default=DEFAULT_EDGE_FEATHER,
        help=f"Additional distance width for soft edge feathering (default: {DEFAULT_EDGE_FEATHER}).",
    )
    return parser.parse_args()


def resolve_source_path(cli_source: Path | None, dry_run: bool) -> Path:
    """Resolve input image path, preferring existing local backup before external copy."""
    if cli_source is not None:
        resolved = cli_source.expanduser().resolve()
        if not resolved.is_file():
            raise FileNotFoundError(f"Specified source image not found: {resolved}")
        return resolved

    if BACKUP_SOURCE_PATH.is_file():
        return BACKUP_SOURCE_PATH

    if DEFAULT_EXTERNAL_SOURCE.is_file():
        if dry_run:
            return DEFAULT_EXTERNAL_SOURCE
        ICON_DIR.mkdir(parents=True, exist_ok=True)
        shutil.copy2(DEFAULT_EXTERNAL_SOURCE, BACKUP_SOURCE_PATH)
        return BACKUP_SOURCE_PATH

    raise FileNotFoundError(
        f"Neither backup ({BACKUP_SOURCE_PATH}) nor external source ({DEFAULT_EXTERNAL_SOURCE}) exists."
    )


def clamp_byte(value: int) -> int:
    """Clamp an integer to the 0..255 byte range."""
    if value < 0:
        return 0
    if value > 255:
        return 255
    return value


def detect_corner_background_rgb(img: Image.Image) -> tuple[int, int, int]:
    """Compute mean RGB color across the four image corners."""
    width, height = img.size
    corners = [
        (0, 0),
        (width - 1, 0),
        (0, height - 1),
        (width - 1, height - 1),
    ]
    samples = [img.getpixel(pos)[:3] for pos in corners]
    avg_r = round(sum(c[0] for c in samples) / len(samples))
    avg_g = round(sum(c[1] for c in samples) / len(samples))
    avg_b = round(sum(c[2] for c in samples) / len(samples))
    return (avg_r, avg_g, avg_b)


def build_channel_sq_tables(bg_rgb: tuple[int, int, int]) -> tuple[list[int], list[int], list[int]]:
    """Precompute squared per-channel differences against the detected background color."""
    bg_r, bg_g, bg_b = bg_rgb
    return (
        [(val - bg_r) ** 2 for val in range(256)],
        [(val - bg_g) ** 2 for val in range(256)],
        [(val - bg_b) ** 2 for val in range(256)],
    )


def flood_fill_outer_background(
    rgba_bytes: bytes,
    width: int,
    height: int,
    sq_tables: tuple[list[int], list[int], list[int]],
    tolerance: int,
) -> bytearray:
    """Identify background pixels connected to image borders via 4-neighbor BFS."""
    dr_sq, dg_sq, db_sq = sq_tables
    tol_sq = tolerance * tolerance
    outer_bg = bytearray(width * height)
    queue: deque[int] = deque()

    def try_enqueue(idx: int) -> None:
        if outer_bg[idx]:
            return
        base = idx * 4
        dist_sq = dr_sq[rgba_bytes[base]] + dg_sq[rgba_bytes[base + 1]] + db_sq[rgba_bytes[base + 2]]
        if dist_sq <= tol_sq:
            outer_bg[idx] = 1
            queue.append(idx)

    for x in range(width):
        try_enqueue(x)
        try_enqueue((height - 1) * width + x)
    for y in range(1, height - 1):
        try_enqueue(y * width)
        try_enqueue(y * width + (width - 1))

    while queue:
        idx = queue.popleft()
        x = idx % width
        y = idx // width
        if x > 0:
            try_enqueue(idx - 1)
        if x + 1 < width:
            try_enqueue(idx + 1)
        if y > 0:
            try_enqueue(idx - width)
        if y + 1 < height:
            try_enqueue(idx + width)

    return outer_bg


def find_boundary_indices(outer_bg: bytearray, width: int, height: int) -> list[int]:
    """Return pixel indices within 8-neighborhood distance 1..2 px of outer_bg."""
    mask_img = Image.frombytes("L", (width, height), bytes(outer_bg))
    dilated = mask_img.filter(ImageFilter.MaxFilter(size=BOUNDARY_FILTER_SIZE)).tobytes()
    return [idx for idx, near in enumerate(dilated) if near and not outer_bg[idx]]


def apply_outer_transparency(
    img: Image.Image,
    bg_rgb: tuple[int, int, int],
    tolerance: int,
    feather: int,
) -> tuple[Image.Image, int]:
    """Make outer background transparent and soften/defringe the rounded-corner boundary."""
    width, height = img.size
    rgba_buf = bytearray(img.tobytes())
    sq_tables = build_channel_sq_tables(bg_rgb)
    dr_sq, dg_sq, db_sq = sq_tables

    outer_bg = flood_fill_outer_background(rgba_buf, width, height, sq_tables, tolerance)
    outer_count = 0
    for idx, is_bg in enumerate(outer_bg):
        if is_bg:
            base = idx * 4
            rgba_buf[base] = 0
            rgba_buf[base + 1] = 0
            rgba_buf[base + 2] = 0
            rgba_buf[base + 3] = 0
            outer_count += 1

    boundary_indices = find_boundary_indices(outer_bg, width, height)
    feather_span = max(1, feather)
    feather_limit = tolerance + feather_span
    bg_r, bg_g, bg_b = bg_rgb

    for idx in boundary_indices:
        base = idx * 4
        r = rgba_buf[base]
        g = rgba_buf[base + 1]
        b = rgba_buf[base + 2]
        orig_a = rgba_buf[base + 3]

        dist = math.sqrt(dr_sq[r] + dg_sq[g] + db_sq[b])
        if dist >= feather_limit:
            continue

        ratio = max(0.0, min(1.0, (dist - tolerance) / feather_span))
        new_alpha = round(orig_a * ratio)
        if new_alpha <= 0:
            rgba_buf[base] = 0
            rgba_buf[base + 1] = 0
            rgba_buf[base + 2] = 0
            rgba_buf[base + 3] = 0
            continue

        # Approximate unpremultiplied foreground color to remove white fringe halo.
        inv_ratio = 1.0 - ratio
        denom = max(ratio, MIN_UNPREMULTIPLY_RATIO)
        rgba_buf[base] = clamp_byte(round((r - bg_r * inv_ratio) / denom))
        rgba_buf[base + 1] = clamp_byte(round((g - bg_g * inv_ratio) / denom))
        rgba_buf[base + 2] = clamp_byte(round((b - bg_b * inv_ratio) / denom))
        rgba_buf[base + 3] = new_alpha

    result = Image.frombytes("RGBA", (width, height), bytes(rgba_buf))
    return result, outer_count


def compute_alpha_crop_box(img: Image.Image) -> tuple[int, int, int, int]:
    """Compute foreground bounding box where alpha > ALPHA_CROP_THRESHOLD."""
    alpha = img.getchannel("A")
    mask = alpha.point(lambda a: 255 if a > ALPHA_CROP_THRESHOLD else 0)
    bbox = mask.getbbox()
    if bbox is None:
        return (0, 0, img.width, img.height)
    return bbox


def build_master_image(img: Image.Image, crop_box: tuple[int, int, int, int]) -> Image.Image:
    """Crop foreground, fit into 1024x1024 transparent canvas using Lanczos, and center."""
    cropped = img.crop(crop_box)
    max_side = max(cropped.width, cropped.height)
    scale = MASTER_SIZE / max_side
    new_w = round(cropped.width * scale)
    new_h = round(cropped.height * scale)

    resized = cropped.resize((new_w, new_h), Image.Resampling.LANCZOS)
    canvas = Image.new("RGBA", (MASTER_SIZE, MASTER_SIZE), (0, 0, 0, 0))
    offset_x = (MASTER_SIZE - new_w) // 2
    offset_y = (MASTER_SIZE - new_h) // 2
    canvas.paste(resized, (offset_x, offset_y), resized)
    return canvas


def collect_output_paths() -> list[Path]:
    """Return full list of all generated icon artifact paths."""
    paths = [MASTER_ICON_PATH, APP_ICO_PATH]
    paths.extend(ICON_DIR / rel for rel, _ in DESKTOP_PNG_TARGETS)
    paths.extend(ANDROID_DIR / rel for rel, _ in ANDROID_FLAT_TARGETS)
    paths.extend(ANDROID_DIR / rel for rel, _ in ANDROID_MIPMAP_TARGETS)
    return paths


def resize_icon_frame(master: Image.Image, size: tuple[int, int]) -> Image.Image:
    """Resize master RGBA icon with LANCZOS and apply RGB-only unsharp mask for small sizes."""
    resized = master.resize(size, Image.Resampling.LANCZOS)
    if size[0] > SMALL_ICON_SHARPEN_MAX_PX:
        return resized

    r, g, b, a = resized.split()
    rgb = Image.merge("RGB", (r, g, b)).filter(
        ImageFilter.UnsharpMask(radius=0.6, percent=90, threshold=2)
    )
    sr, sg, sb = rgb.split()
    return Image.merge("RGBA", (sr, sg, sb, a))


def save_resized_png(master: Image.Image, target_path: Path, size: int) -> None:
    """Resize master 1024x1024 image to square PNG and save."""
    target_path.parent.mkdir(parents=True, exist_ok=True)
    resized = resize_icon_frame(master, (size, size))
    resized.save(target_path, format="PNG")


def generate_icons(source_path: Path, tolerance: int, feather: int, dry_run: bool) -> None:
    """Execute outer background removal, optional dry-run output, and icon generation."""
    if tolerance < 0:
        raise ValueError(f"--tolerance must be non-negative, got {tolerance}")

    with Image.open(source_path) as opened:
        img = opened.convert("RGBA")

    bg_rgb = detect_corner_background_rgb(img)
    transparent_img, outer_count = apply_outer_transparency(img, bg_rgb, tolerance, feather)
    crop_box = compute_alpha_crop_box(transparent_img)
    outputs = collect_output_paths()

    print(f"Source: {source_path} ({img.width}x{img.height})")
    print(f"Detected background RGB: {bg_rgb}, outer_bg pixels: {outer_count}")
    print(
        f"Crop box (x0, y0, x1, y1): {crop_box} "
        f"-> {crop_box[2] - crop_box[0]}x{crop_box[3] - crop_box[1]}"
    )

    if dry_run:
        print("Dry-run mode enabled. Planned output files:")
        if not BACKUP_SOURCE_PATH.exists() and source_path.resolve() == DEFAULT_EXTERNAL_SOURCE.resolve():
            print(f"  - {BACKUP_SOURCE_PATH} (backup copy)")
        for out_path in outputs:
            print(f"  - {out_path}")
        return

    master = build_master_image(transparent_img, crop_box)
    ICON_DIR.mkdir(parents=True, exist_ok=True)
    master.save(MASTER_ICON_PATH, format="PNG")

    for rel, size in DESKTOP_PNG_TARGETS:
        save_resized_png(master, ICON_DIR / rel, size)

    for rel, size in ANDROID_FLAT_TARGETS + ANDROID_MIPMAP_TARGETS:
        save_resized_png(master, ANDROID_DIR / rel, size)

    frames = [resize_icon_frame(master, s) for s in ICO_SIZES]
    frames[-1].save(APP_ICO_PATH, format="ICO", sizes=ICO_SIZES, append_images=frames[:-1])
    print(f"Generated {len(outputs)} transparent icon files under {ICON_DIR}")


def main() -> int:
    args = parse_args()
    try:
        source_path = resolve_source_path(args.source, args.dry_run)
        generate_icons(source_path, args.tolerance, args.feather, args.dry_run)
        return 0
    except Exception as exc:
        print(f"[build-icons] Error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
