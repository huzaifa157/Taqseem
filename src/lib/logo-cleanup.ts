// Cleans an uploaded logo before it is stored: the plain background around it (a grey or white
// square from a photo or a JPEG) becomes transparent, and the empty edges are trimmed, so the
// logo itself fills the space on the bill. Pure pixel work, so it is unit-tested; the settings
// form runs it on a canvas in the browser.

export type Rgba = { data: Uint8ClampedArray; width: number; height: number };
export type Crop = { x: number; y: number; width: number; height: number };

/** Colour distance (0–441) under which a pixel counts as background. */
const TOLERANCE = 38;

const distance = (d: Uint8ClampedArray, i: number, bg: [number, number, number]) =>
  Math.hypot(d[i]! - bg[0], d[i + 1]! - bg[1], d[i + 2]! - bg[2]);

/**
 * The background colour: the most common colour along the image border (rounded to 16 levels),
 * or null when the border is already mostly transparent or has no colour in common.
 */
export function borderColour({ data, width, height }: Rgba): [number, number, number] | null {
  const counts = new Map<number, { n: number; r: number; g: number; b: number }>();
  let total = 0;
  let clear = 0;
  const visit = (x: number, y: number) => {
    const i = (y * width + x) * 4;
    total++;
    if (data[i + 3]! < 128) {
      clear++;
      return;
    }
    const key = ((data[i]! >> 4) << 8) | ((data[i + 1]! >> 4) << 4) | (data[i + 2]! >> 4);
    const c = counts.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
    c.n++;
    c.r += data[i]!;
    c.g += data[i + 1]!;
    c.b += data[i + 2]!;
    counts.set(key, c);
  };
  for (let x = 0; x < width; x++) {
    visit(x, 0);
    visit(x, height - 1);
  }
  for (let y = 1; y < height - 1; y++) {
    visit(0, y);
    visit(width - 1, y);
  }
  if (clear > total / 2) return null;
  let best: { n: number; r: number; g: number; b: number } | null = null;
  for (const c of counts.values()) if (!best || c.n > best.n) best = c;
  // A background is one colour around most of the edge; a logo running off the edge is not.
  if (!best || best.n < total * 0.6) return null;
  return [best.r / best.n, best.g / best.n, best.b / best.n];
}

/**
 * Makes the background transparent where it touches the border (so a white or grey inside the
 * logo stays), with soft edges, in place. Returns false when there is no plain background.
 */
export function removeBackground(img: Rgba): boolean {
  const bg = borderColour(img);
  if (!bg) return false;
  const { data, width, height } = img;
  const seen = new Uint8Array(width * height);
  const queue: number[] = [];
  const push = (p: number) => {
    if (seen[p]) return;
    seen[p] = 1;
    const i = p * 4;
    if (data[i + 3]! === 0) {
      queue.push(p);
      return;
    }
    const d = distance(data, i, bg);
    if (d < TOLERANCE) {
      data[i + 3] = 0;
      queue.push(p);
    } else if (d < TOLERANCE * 2) {
      // The edge of the logo: partly see-through, not spread further.
      data[i + 3] = Math.min(data[i + 3]!, Math.round((255 * (d - TOLERANCE)) / TOLERANCE));
    }
  };
  for (let x = 0; x < width; x++) {
    push(x);
    push((height - 1) * width + x);
  }
  for (let y = 0; y < height; y++) {
    push(y * width);
    push(y * width + width - 1);
  }
  while (queue.length) {
    const p = queue.pop()!;
    const x = p % width;
    if (x > 0) push(p - 1);
    if (x < width - 1) push(p + 1);
    if (p >= width) push(p - width);
    if (p < width * (height - 1)) push(p + width);
  }
  return true;
}

/** The box around what can be seen (alpha above a faint level), with a small margin. */
export function contentBox({ data, width, height }: Rgba): Crop | null {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      if (data[(y * width + x) * 4 + 3]! > 24) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
  if (maxX < 0) return null;
  const pad = Math.round(Math.max(maxX - minX, maxY - minY) * 0.02);
  const x = Math.max(0, minX - pad);
  const y = Math.max(0, minY - pad);
  return {
    x,
    y,
    width: Math.min(width, maxX + pad + 1) - x,
    height: Math.min(height, maxY + pad + 1) - y,
  };
}
