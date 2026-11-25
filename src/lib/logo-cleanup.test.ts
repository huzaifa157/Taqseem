import { describe, expect, it } from "vitest";

import { contentBox, removeBackground, type Rgba } from "./logo-cleanup";

/** A w×h image of one colour, with a rectangle of another painted on it. */
function image(
  w: number,
  h: number,
  bg: number[],
  box?: { x: number; y: number; w: number; h: number; c: number[] },
): Rgba {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const inBox = box && x >= box.x && x < box.x + box.w && y >= box.y && y < box.y + box.h;
      data.set(inBox ? box.c : bg, (y * w + x) * 4);
    }
  return { data, width: w, height: h };
}
const alpha = (img: Rgba, x: number, y: number) => img.data[(y * img.width + x) * 4 + 3];

describe("logo cleanup", () => {
  it("makes a grey square background transparent and trims to the logo", () => {
    // 100×100 light grey with a 40×20 green logo in the middle.
    const img = image(100, 100, [238, 238, 238, 255], {
      x: 30,
      y: 40,
      w: 40,
      h: 20,
      c: [40, 160, 60, 255],
    });
    expect(removeBackground(img)).toBe(true);
    expect(alpha(img, 2, 2)).toBe(0);
    expect(alpha(img, 50, 50)).toBe(255);
    // The box is the logo plus a 2% margin (1 px of 40).
    expect(contentBox(img)).toEqual({ x: 29, y: 39, width: 42, height: 22 });
  });

  it("keeps white inside the logo that does not touch the border", () => {
    // Grey background; a green frame with a white hole in it.
    const img = image(60, 60, [230, 230, 230, 255], {
      x: 10,
      y: 10,
      w: 40,
      h: 40,
      c: [20, 120, 40, 255],
    });
    for (let y = 20; y < 40; y++)
      for (let x = 20; x < 40; x++) img.data.set([232, 232, 232, 255], (y * 60 + x) * 4);
    removeBackground(img);
    expect(alpha(img, 0, 0)).toBe(0);
    expect(alpha(img, 30, 30)).toBe(255);
  });

  it("leaves a logo without a plain background alone", () => {
    // Half red, half blue: no colour runs around the edge.
    const img = image(40, 40, [200, 0, 0, 255], {
      x: 0,
      y: 0,
      w: 20,
      h: 40,
      c: [0, 0, 200, 255],
    });
    expect(removeBackground(img)).toBe(false);
    expect(contentBox(img)).toEqual({ x: 0, y: 0, width: 40, height: 40 });
  });

  it("trims an already transparent background", () => {
    const img = image(50, 50, [0, 0, 0, 0], { x: 5, y: 10, w: 20, h: 5, c: [0, 0, 0, 255] });
    expect(removeBackground(img)).toBe(false);
    expect(contentBox(img)).toEqual({ x: 5, y: 10, width: 20, height: 5 });
  });
});
