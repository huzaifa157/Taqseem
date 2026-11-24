import { z } from "zod";

import {
  dateSchema,
  idSchema,
  optionalMoneySchema,
  optionalText,
  packetsSchema,
  requestIdSchema,
} from "./master";

// Customer damage (Damage screen), shared by the form, the server action and the service.

/** A line: product and quantity (dozens, or loose packets "3pk"); rate per dozen, blank = default. */
export const damageLineSchema = z.object({
  productId: idSchema,
  quantity: packetsSchema("quantity", { min: 1 }),
  rate: optionalMoneySchema("rate"),
});

const lines = (label: string) =>
  z
    .array(damageLineSchema)
    .max(100)
    .superRefine((ls, ctx) => {
      const seen = new Set<string>();
      ls.forEach((l, i) => {
        if (seen.has(l.productId))
          ctx.addIssue({
            code: "custom",
            path: [i, "productId"],
            message: `${label}: a product appears twice`,
          });
        seen.add(l.productId);
      });
    });

export const damageSchema = z.object({
  requestId: requestIdSchema,
  customerId: z.string({ error: "Choose the customer" }).min(1, "Choose the customer").max(40),
  returnDate: dateSchema("date"),
  note: optionalText(300),
  /** The damaged goods the customer brought back. */
  damaged: lines("Damaged").min(1, "Add the damaged items"),
  /** Goods given in exchange (none: only a credit). */
  replacements: lines("Given in exchange").default([]),
});

export type DamageInput = z.infer<typeof damageSchema>;
