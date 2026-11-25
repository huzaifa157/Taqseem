import { z } from "zod";

import { blankToUndefined, dateSchema, moneySchema, optionalText, requestIdSchema } from "./master";

/** Cash book entries a person adds by hand (opening cash and count differences have their own). */
export const CASH_MOVE_KINDS = ["ADDED", "TAKEN_OUT", "BANK_DEPOSIT", "BANK_WITHDRAWAL"] as const;
export type CashMoveKind = (typeof CASH_MOVE_KINDS)[number];

export const CASH_KIND_LABEL: Record<string, string> = {
  OPENING: "Opening cash",
  ADDED: "Cash put in",
  TAKEN_OUT: "Cash taken out",
  BANK_DEPOSIT: "Taken to the bank",
  BANK_WITHDRAWAL: "Brought from the bank",
  COUNT_DIFFERENCE: "Count difference",
};

const positive = (label: string) =>
  moneySchema(label).refine((v) => Number(v) > 0, `The ${label} must be more than zero`);

const tick = z
  .preprocess((v) => v === true || v === "true" || v === "on", z.boolean())
  .default(false);

/** The cash in the drawer on the day the book starts. */
export const openingCashSchema = z.object({
  requestId: requestIdSchema,
  entryDate: dateSchema("date"),
  amount: moneySchema("amount"),
  note: optionalText(300),
});

/** Cash put in or taken out by the owner, or taken to / brought from the bank. */
export const cashMoveSchema = z.object({
  requestId: requestIdSchema,
  entryDate: dateSchema("date"),
  kind: z.preprocess(blankToUndefined, z.enum(CASH_MOVE_KINDS, { error: "Choose what it is" })),
  amount: positive("amount"),
  note: optionalText(300),
});

/** The cash counted in the drawer at the end of a day. */
export const cashCountSchema = z.object({
  countDate: dateSchema("date"),
  counted: moneySchema("cash counted"),
  note: optionalText(300),
  /** Set the book to the count (posts the shortage or extra as a count difference). */
  correct: tick,
});
