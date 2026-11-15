"use client";

import { useEffect } from "react";

import { COPY_MIN_FONT_PT } from "@/lib/print";

/**
 * Shrinks the text of fixed-size boxes just enough for their content to fit (down to `minPt`),
 * instead of cutting it off or spilling onto another page. Runs on screen (the preview has the
 * printed size), once the fonts are in, and again just before printing. Renders nothing.
 */
export function FitText({
  selector,
  fontPt,
  minPt,
}: {
  selector: string;
  fontPt: number;
  minPt: number;
}) {
  useEffect(() => {
    const fit = () => {
      // Measured in the screen layout only, where the boxes have their printed size; in the print
      // layout a box may have no fixed height (any page size), and the size found is kept.
      if (window.matchMedia("print").matches) return;
      for (const box of document.querySelectorAll<HTMLElement>(selector))
        shrinkToFit(box, fontPt, minPt);
    };
    fit();
    void document.fonts?.ready.then(fit);
    window.addEventListener("beforeprint", fit);
    return () => window.removeEventListener("beforeprint", fit);
  }, [selector, fontPt, minPt]);
  return null;
}

function shrinkToFit(box: HTMLElement, fontPt: number, minPt: number) {
  let size = fontPt;
  box.style.fontSize = `${size}pt`;
  while (box.scrollHeight > box.clientHeight + 1 && size > minPt) {
    size = Math.max(minPt, size - 0.5);
    box.style.fontSize = `${size}pt`;
  }
  return box.scrollHeight <= box.clientHeight + 1;
}

/** Pixels in one millimetre on this screen (the preview is laid out in mm). */
function pxPerMm() {
  const probe = document.createElement("div");
  probe.style.cssText = "position:absolute;visibility:hidden;width:100mm;height:0";
  document.body.appendChild(probe);
  const px = probe.getBoundingClientRect().width / 100;
  probe.remove();
  return px;
}

/**
 * Two bills (or two copies) to a sheet: each half has a fixed size, so a bill too long for it
 * would be cut off (its totals lost) or push the cut line onto another page. Copies first shrink
 * their text (down to COPY_MIN_FONT_PT); a sheet whose bill still does not fit is marked
 * `data-long`, and prints its bills one after the other on full pages instead (lib/print.ts).
 * Measured in the screen preview, which has the printed size; again just before printing.
 */
export function FitBills({ fontPt, shrink }: { fontPt: number; shrink: boolean }) {
  useEffect(() => {
    const fit = () => {
      if (window.matchMedia("print").matches) return;
      const perMm = pxPerMm();
      for (const sheet of document.querySelectorAll<HTMLElement>(".print-sheet")) {
        delete sheet.dataset.long; // measure in the half-sheet layout
        let fits = true;
        for (const bill of sheet.querySelectorAll<HTMLElement>(".print-bill")) {
          if (shrink) {
            if (!shrinkToFit(bill, fontPt, COPY_MIN_FONT_PT)) fits = false;
          } else {
            const limit = Number(bill.dataset.heightMm) * perMm;
            if (limit && bill.scrollHeight > limit + 1) fits = false;
          }
        }
        if (!fits) {
          sheet.dataset.long = "";
          // On full pages there is room: the normal size again.
          if (shrink)
            for (const bill of sheet.querySelectorAll<HTMLElement>(".print-bill"))
              bill.style.fontSize = `${fontPt}pt`;
        }
      }
    };
    fit();
    void document.fonts?.ready.then(fit);
    window.addEventListener("beforeprint", fit);
    return () => window.removeEventListener("beforeprint", fit);
  }, [fontPt, shrink]);
  return null;
}
