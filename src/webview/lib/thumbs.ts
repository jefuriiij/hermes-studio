// Small square thumbnails for image chips, made in the webview: the host has
// no image decoder, and a chip should not hold a multi-megabyte data: URL.

import { IMAGE_TYPES, type ImagePreview } from "$shared/protocol";

/** A data: URL for a picture from the host, or undefined if it is not a
 *  known image type as plain base64 (only those become URLs). */
export function imageSrc(img: ImagePreview | null | undefined): string | undefined {
  if (!img || !IMAGE_TYPES.has(img.mimeType) || !/^[A-Za-z0-9+/]+={0,2}$/.test(img.data)) {
    return undefined;
  }
  return `data:${img.mimeType};base64,${img.data}`;
}

/** The centre square of the picture, `px` pixels wide (2× the 16 px chip
 *  thumbnail, for HiDPI screens). An animated GIF gives its first frame. */
export async function makeThumb(src: string, px = 32): Promise<string | undefined> {
  const img = new Image();
  img.src = src;
  try {
    await img.decode();
  } catch {
    return undefined;
  }
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  if (!w || !h) return undefined;
  const side = Math.min(w, h);
  const canvas = document.createElement("canvas");
  canvas.width = px;
  canvas.height = px;
  const g = canvas.getContext("2d");
  if (!g) return undefined;
  g.imageSmoothingQuality = "high";
  g.drawImage(img, (w - side) / 2, (h - side) / 2, side, side, 0, 0, px, px);
  return canvas.toDataURL("image/png");
}
