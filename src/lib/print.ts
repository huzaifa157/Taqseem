// Print layout rules (SPEC §11), shared by every printable page. Pure, so they are unit-tested.
//
// Bills print on the tenant's paper (A5 by default; A4, half-A4, A6 or a custom size), two to an
// A4 sheet, or two copies of the same bill side by side on one A5 sheet turned sideways (ORIGINAL
// and DUPLICATE). Statements and reports print on A4. Margins and font size are tenant settings.

export const PAPER_SIZES = ["A5", "A4", "HALF_A4", "A6", "CUSTOM"] as const;
export type PaperSize = (typeof PAPER_SIZES)[number];

export const PAPER_LABEL: Record<PaperSize, string> = {
  A5: "A5 (148 × 210 mm)",
  A4: "A4 (210 × 297 mm)",
  HALF_A4: "Half A4 (210 × 148.5 mm)",
  A6: "A6 (105 × 148 mm)",
  CUSTOM: "Custom size",
};

const DIMENSIONS: Record<Exclude<PaperSize, "CUSTOM">, [number, number]> = {
  A4: [210, 297],
  A5: [148, 210],
  HALF_A4: [210, 148.5],
  A6: [105, 148],
};

export type PrintSettings = {
  paper: PaperSize;
  widthMm?: number | null;
  heightMm?: number | null;
  marginMm: number;
  fontSizePt: number;
  twoPerA4: boolean;
  /**
   * Each bill printed twice on one A5 sheet turned sideways (210 × 148 mm): two tall halves side
   * by side, ORIGINAL and DUPLICATE, with a cut line; always the compact bill.
   */
  twoCopiesPerA5?: boolean;
  /** The short bill layout, for small paper. */
  compact?: boolean;
};

export const DEFAULT_PRINT_SETTINGS: PrintSettings = {
  paper: "A5",
  marginMm: 8,
  fontSizePt: 10,
  twoPerA4: false,
  twoCopiesPerA5: false,
  compact: false,
};

export type BillLayout = {
  /** The physical sheet that goes through the printer. */
  sheet: { widthMm: number; heightMm: number };
  /** The space for one bill (a whole sheet, or the top or bottom half of one). */
  bill: { widthMm: number; heightMm: number };
  perSheet: 1 | 2;
  /** 2 when both halves of a sheet hold the same bill (two copies per A5). */
  copies: 1 | 2;
  /** The halves side by side (two copies per A5, sideways) rather than one above the other. */
  sideBySide: boolean;
};

/** Two copies per A5: the copies, left to right. */
export const COPY_LABELS = ["ORIGINAL", "DUPLICATE"] as const;
/** Two copies per A5: the space around each copy (a thin edge, as on small-printer bills). */
export const COPY_MARGIN_MM = 4;
/**
 * Two copies per A5: the text starts bigger than the setting for readability, and shrinks (to
 * no less than COPY_MIN_FONT_PT) only when a long bill would not fit its half otherwise.
 */
export const COPY_FONT_PT = 11;
export const COPY_MIN_FONT_PT = 7;
export const copyFontPt = (s: Pick<PrintSettings, "fontSizePt">) =>
  Math.max(s.fontSizePt, COPY_FONT_PT);

/** The short bill layout: chosen in Settings, and always for two copies per A5. */
export const usesCompactBill = (s: PrintSettings) => Boolean(s.compact || s.twoCopiesPerA5);

export function paperSize(s: Pick<PrintSettings, "paper" | "widthMm" | "heightMm">): {
  widthMm: number;
  heightMm: number;
} {
  if (s.paper === "CUSTOM") {
    if (!s.widthMm || !s.heightMm) return { widthMm: DIMENSIONS.A5[0], heightMm: DIMENSIONS.A5[1] };
    return { widthMm: s.widthMm, heightMm: s.heightMm };
  }
  const [widthMm, heightMm] = DIMENSIONS[s.paper];
  return { widthMm, heightMm };
}

export function billLayout(s: PrintSettings): BillLayout {
  if (s.twoCopiesPerA5) {
    return {
      sheet: { widthMm: 210, heightMm: 148 },
      bill: { widthMm: 105, heightMm: 148 },
      perSheet: 2,
      copies: 2,
      sideBySide: true,
    };
  }
  if (s.twoPerA4) {
    return {
      sheet: { widthMm: 210, heightMm: 297 },
      bill: { widthMm: 210, heightMm: 148.5 },
      perSheet: 2,
      copies: 1,
      sideBySide: false,
    };
  }
  const size = paperSize(s);
  return { sheet: size, bill: size, perSheet: 1, copies: 1, sideBySide: false };
}

/**
 * Groups bills into printed sheets: one per sheet, pairs when printing two per A4, or each bill
 * next to its own copy when printing two copies per A5.
 */
export function toSheets<T>(items: T[], perSheet: 1 | 2, copies: 1 | 2 = 1): T[][] {
  if (copies === 2) return items.map((item) => [item, item]);
  const sheets: T[][] = [];
  for (let i = 0; i < items.length; i += perSheet) sheets.push(items.slice(i, i + perSheet));
  return sheets;
}

const mm = (n: number) => `${Number(n.toFixed(2))}mm`;

/**
 * Two to a sheet, but a bill too long for its half (marked `data-long` in the preview): instead
 * of being cut off, or pushing the cut line onto another page, its sheet prints the bills one
 * after the other on full pages, each starting on a new page, its margin repeated on every page.
 */
const LONG_PRINT_CSS = [
  `  .print-sheet[data-long] { height: auto; display: block; break-after: page; }`,
  `  .print-sheet[data-long]:last-child { break-after: auto; }`,
  `  .print-sheet[data-long] .print-bill { width: auto; height: auto; overflow: visible; -webkit-box-decoration-break: clone; box-decoration-break: clone; }`,
  `  .print-sheet[data-long] .print-bill + .print-bill { border: 0; break-before: page; }`,
].join("\n");

/**
 * Print CSS for a page of bills. One bill per sheet: the page margin is the setting and a long bill
 * flows onto further pages. Two per sheet (two per A4, or two copies per A5): no page margin, each
 * half gets the margin as padding, with a dashed cut line between the halves.
 */
export function billPageCss(s: PrintSettings): string {
  const layout = billLayout(s);
  const common = `.print-root { font-size: ${s.fontSizePt}pt; }`;
  if (layout.sideBySide) {
    const { sheet, bill } = layout;
    return [
      `@page { size: ${mm(sheet.widthMm)} ${mm(sheet.heightMm)}; margin: 0; }`,
      `.print-root { font-size: ${copyFontPt(s)}pt; }`,
      `@media print {`,
      `  .print-sheet { width: ${mm(sheet.widthMm)}; height: ${mm(sheet.heightMm)}; break-after: page; display: flex; flex-direction: row; }`,
      `  .print-sheet:last-child { break-after: auto; }`,
      `  .print-bill { width: ${mm(bill.widthMm)}; height: ${mm(bill.heightMm)}; padding: ${mm(COPY_MARGIN_MM)}; overflow: hidden; box-sizing: border-box; position: relative; }`,
      `  .print-bill + .print-bill { border-left: 1px dashed #000; }`,
      LONG_PRINT_CSS,
      `}`,
    ].join("\n");
  }
  if (layout.perSheet === 2) {
    const { sheet, bill } = layout;
    return [
      `@page { size: ${mm(sheet.widthMm)} ${mm(sheet.heightMm)}; margin: 0; }`,
      common,
      `@media print {`,
      `  .print-sheet { width: ${mm(sheet.widthMm)}; height: ${mm(sheet.heightMm)}; break-after: page; display: flex; flex-direction: column; }`,
      `  .print-sheet:last-child { break-after: auto; }`,
      `  .print-bill { height: ${mm(bill.heightMm)}; padding: ${mm(s.marginMm)}; overflow: hidden; box-sizing: border-box; }`,
      `  .print-bill + .print-bill { border-top: 1px dashed #000; }`,
      LONG_PRINT_CSS,
      `}`,
    ].join("\n");
  }
  return [
    `@page { size: ${mm(layout.sheet.widthMm)} ${mm(layout.sheet.heightMm)}; margin: ${mm(s.marginMm)}; }`,
    common,
    `@media print {`,
    `  .print-sheet { break-after: page; }`,
    `  .print-sheet:last-child { break-after: auto; }`,
    `}`,
  ].join("\n");
}

/** Print CSS for statements and reports: A4 portrait with the tenant's margin and font size. */
export function statementPageCss(s: PrintSettings): string {
  return [
    `@page { size: ${mm(210)} ${mm(297)}; margin: ${mm(Math.max(s.marginMm, 8))}; }`,
    `.print-root { font-size: ${s.fontSizePt}pt; }`,
  ].join("\n");
}

/**
 * Trip sheets (loading sheet, driver sheet, or both front and back). No page size or orientation
 * is set, so the print dialog keeps all its controls (paper, portrait / landscape, two-sided):
 * the sheets fit whatever is chosen. Landscape A4 is the intended layout: the loading sheet's text
 * starts large and shrinks only as much as a big load needs to stay on one landscape page (the
 * front), and the driver sheet's columns are shares of the page width, in smaller text when the
 * page is upright.
 */
/**
 * Landscape A4 with room at the edges: 14 mm at the sides (most printers cannot print the outer
 * 4–6 mm, and the sides were cut off with 7 mm), 10 mm top and bottom.
 */
export const TRIP_SHEET_PAGE_MM = { width: 297, height: 210, marginX: 14, marginY: 10 } as const;
/** The printable width of a trip sheet: the screen preview is laid out at this width. */
export const TRIP_SHEET_INNER_WIDTH_MM = TRIP_SHEET_PAGE_MM.width - 2 * TRIP_SHEET_PAGE_MM.marginX;
export const DRIVER_SHEET_FONT_PT = 9;
/** The driver sheet's text when printed upright (portrait), so its 14 columns still fit. */
export const DRIVER_SHEET_PORTRAIT_FONT_PT = 6.5;
export const LOADING_SHEET_FONT_PT = 13;
export const LOADING_SHEET_MIN_FONT_PT = 7;

export function tripSheetCss(): string {
  const { width, height, marginX, marginY } = TRIP_SHEET_PAGE_MM;
  return [
    `@page { margin: ${mm(marginY)} ${mm(marginX)}; }`,
    `.print-root { font-size: ${DRIVER_SHEET_FONT_PT}pt; }`,
    // On screen the loading sheet is one landscape page, so the fitting measures that page.
    `@media screen { .loading-page { width: ${mm(width - 2 * marginX)}; height: ${mm(height - 2 * marginY - 1)}; overflow: hidden; box-sizing: border-box; } }`,
    `@media print { .loading-page { break-after: page; } .loading-page:last-child { break-after: auto; } }`,
    `@media print and (orientation: portrait) { .print-root { font-size: ${DRIVER_SHEET_PORTRAIT_FONT_PT}pt; } }`,
  ].join("\n");
}

/** "Prints on A5 (148 × 210 mm)" and similar, shown next to the print button. */
export function paperHint(s: PrintSettings): string {
  if (s.twoCopiesPerA5) return "Prints 2 copies of each bill side by side on A5, sideways";
  if (s.twoPerA4) return "Prints 2 bills per A4 sheet";
  if (s.paper === "CUSTOM") {
    const { widthMm, heightMm } = paperSize(s);
    return `Prints on ${widthMm} × ${heightMm} mm paper`;
  }
  return `Prints on ${PAPER_LABEL[s.paper]}`;
}

// ───────────── Bill pages ─────────────
// A bill on its own sheet is laid out page by page: every line is one row of a fixed height, so
// how many fit is a sum, not a measurement. Page 1 has the full header; later pages a short one
// and a "brought forward" row; every page but the last ends with "carried forward"; the last has
// the totals and the account. Heights are in em of the bill's font (the tenant's font size).

/** One line of the bill (one row; a long name is cut short). */
export const BILL_ROW_EM = 1.6;
/** Page 1 above the lines: letterhead, bill to, an optional title, the column heads. */
const FIRST_HEAD_EM = 11;
/** Later pages above the lines: the short header and the column heads. */
const NEXT_HEAD_EM = 6;
/** Every page's footer: the bill note or "continued", and "Page 1 of 2". */
const FOOTER_EM = 2.4;
/** The last page under the lines: totals row, account and "This bill". */
const TOTALS_EM = 12;

export type BillPagination = {
  /** Lines on page 1 when more pages follow (a "carried forward" row comes after them). */
  firstRows: number;
  /** Lines on a later page when more pages follow (between "brought" and "carried forward"). */
  nextRows: number;
  /** Rows' worth of space the totals need on the last page. */
  totalsRows: number;
  /** Height of one page inside the margins. */
  pageHeightMm: number;
  /** Wide enough (A4) for a tick column to check the goods against. */
  wide: boolean;
};

const PT_TO_MM = 0.3528;

/**
 * Page sizes for a bill printed one per sheet in the full layout; null when bills are two to a
 * sheet or compact (those keep flowing as one block, fitted by FitBills).
 */
export function billPagination(s: PrintSettings): BillPagination | null {
  const layout = billLayout(s);
  if (layout.perSheet !== 1 || usesCompactBill(s)) return null;
  const pageHeightMm = layout.sheet.heightMm - 2 * s.marginMm;
  const pageEm = pageHeightMm / (s.fontSizePt * PT_TO_MM);
  const rows = (em: number) => Math.max(1, Math.floor(em / BILL_ROW_EM));
  return {
    firstRows: rows(pageEm - FIRST_HEAD_EM - FOOTER_EM - BILL_ROW_EM),
    nextRows: rows(pageEm - NEXT_HEAD_EM - FOOTER_EM - 2 * BILL_ROW_EM),
    totalsRows: Math.ceil(TOTALS_EM / BILL_ROW_EM),
    pageHeightMm,
    wide: layout.sheet.widthMm >= 180,
  };
}

/**
 * Splits a bill's lines into pages. A page that is not the last is filled up; the last keeps room
 * for the totals (which take the place of "carried forward" plus totalsRows − 1 lines), and always
 * has at least one line, so the totals never stand alone on a page.
 */
export function paginateBill<T>(
  lines: T[],
  p: Pick<BillPagination, "firstRows" | "nextRows" | "totalsRows">,
): T[][] {
  const pages: T[][] = [];
  let i = 0;
  let capacity = p.firstRows;
  for (;;) {
    const remaining = lines.length - i;
    const fitsWithTotals = Math.max(1, capacity + 1 - p.totalsRows);
    if (remaining <= fitsWithTotals) {
      pages.push(lines.slice(i));
      return pages;
    }
    const take = Math.min(capacity, remaining - 1);
    pages.push(lines.slice(i, i + take));
    i += take;
    capacity = p.nextRows;
  }
}
