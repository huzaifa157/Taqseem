import { randomUUID } from "node:crypto";

import { beforeEach, describe, expect, it } from "vitest";

import { ForbiddenError } from "../auth/permissions";
import { prisma } from "../db/client";
import { createTenantDb } from "../db/tenant";
import { createDamageReturn, getDamageReturn, reverseDamageReturn } from "./damage";
import { returnDamagedStock } from "./inventory";
import { createArea } from "./master/areas";
import type { ServiceCtx } from "./master/common";
import { createCompany } from "./master/companies";
import { createCustomer } from "./master/customers";
import { createProduct } from "./master/products";
import { createWarehouse } from "./master/warehouses";
import { createGoodsReceipt } from "./purchasing/goods-receipts";
import { customerPending } from "./sales/positions";

async function setup() {
  const suffix = randomUUID().slice(0, 8);
  const tenant = await prisma.tenant.create({ data: { name: `G ${suffix}`, slug: `g-${suffix}` } });
  const owner = await prisma.user.create({
    data: {
      tenantId: tenant.id,
      email: `g-${suffix}@t.local`,
      name: "Owner",
      role: "OWNER",
      passwordHash: "x",
    },
  });
  const ctx: ServiceCtx = {
    db: createTenantDb(tenant.id),
    user: { id: owner.id, role: "OWNER", tenantId: tenant.id },
  };
  const main = await createWarehouse(ctx, { name: "Main" });
  const area = await createArea(ctx, { warehouseId: main.id, name: "Shahdara" });
  const crunchy = await createCompany(ctx, {
    warehouseId: main.id,
    name: "Crunchy",
    paymentTermsDays: "15",
  });
  // Chips: 228 a dozen less 4 = 224 (cost 100). Nimko: 300, no discount (cost 200).
  const chips = await createProduct(ctx, {
    companyId: crunchy.id,
    code: "CB01",
    name: "Chips",
    purchaseRate: "100",
    saleRate: "228",
    discountType: "AMOUNT_PER_UNIT",
    discountValue: "4",
    effectiveFrom: "2026-10-01",
  });
  const nimko = await createProduct(ctx, {
    companyId: crunchy.id,
    code: "NM01",
    name: "Nimko",
    purchaseRate: "200",
    saleRate: "300",
    effectiveFrom: "2026-10-01",
  });
  await createGoodsReceipt(ctx, {
    companyId: crunchy.id,
    receivedDate: "2026-10-01",
    lines: [
      { productId: chips.id, quantity: "10" },
      { productId: nimko.id, quantity: "2" },
    ],
  });
  const customer = await createCustomer(ctx, {
    name: "Ali Khan",
    type: "RETAILER",
    areaId: area.id,
    openingBalance: "1000",
  });
  return { ctx, crunchy, chips, nimko, customer };
}

let t: Awaited<ReturnType<typeof setup>>;
beforeEach(async () => {
  t = await setup();
});

const DAY = "2026-10-20";
const damage = (extra: object, ctx = t.ctx) =>
  createDamageReturn(ctx, { customerId: t.customer.id, returnDate: DAY, ...extra });
const stock = async (productId: string, bucket: "SALEABLE" | "DAMAGED") =>
  (
    await t.ctx.db.stockMovement.aggregate({
      where: { productId, bucket },
      _sum: { quantity: true },
    })
  )._sum.quantity ?? 0;
const owes = async () => (await customerPending(t.ctx.db, t.customer.id)).total.toFixed(2);

describe("customer damage", () => {
  it("credits the customer at what they paid, puts the goods in damaged stock and claims the company", async () => {
    // 6 packets of chips at 224 a dozen = 112.
    const e = await damage({ damaged: [{ productId: t.chips.id, quantity: "6pk" }] });
    expect(await owes()).toBe("888.00");
    expect(await stock(t.chips.id, "DAMAGED")).toBe(6);
    expect(await stock(t.chips.id, "SALEABLE")).toBe(120);
    const view = await getDamageReturn(t.ctx, e.id);
    expect([view.damagedAmount.toFixed(2), view.account.toFixed(2)]).toEqual(["112.00", "112.00"]);
    expect(view.damagedLines.map((l) => l.rate.toFixed(2))).toEqual(["224.00"]);
    // The company is claimed at the purchase rate (6 pk at 100 a dozen), waiting for approval.
    expect(view.claims.map((c) => [c.type, c.status, c.amount.toFixed(2)])).toEqual([
      ["CUSTOMER_DAMAGE", "AWAITING", "50.00"],
    ]);
  });

  it("an exchange of the same value leaves the account as it is", async () => {
    await damage({
      damaged: [{ productId: t.chips.id, quantity: "1" }],
      replacements: [{ productId: t.chips.id, quantity: "1" }],
    });
    expect(await owes()).toBe("1000.00");
    expect(await stock(t.chips.id, "SALEABLE")).toBe(108);
    expect(await stock(t.chips.id, "DAMAGED")).toBe(12);
    const moves = await t.ctx.db.stockMovement.findMany({
      where: { referenceType: "DamageReturn", type: "DAMAGE_REPLACEMENT" },
    });
    expect(moves.map((m) => m.quantity)).toEqual([-12]);
  });

  it("a replacement worth more is charged to the account; a typed rate is used", async () => {
    // Damaged 1 dz chips at 200 (typed); given 1 dz nimko at 300: the customer owes 100 more.
    await damage({
      damaged: [{ productId: t.chips.id, quantity: "1", rate: "200" }],
      replacements: [{ productId: t.nimko.id, quantity: "1" }],
    });
    expect(await owes()).toBe("1100.00");
    const entry = await t.ctx.db.ledgerEntry.findFirstOrThrow({
      where: { referenceType: "DamageReturn" },
    });
    expect([entry.type, entry.debit.toFixed(2), entry.companyId]).toEqual([
      "ADJUSTMENT",
      "100.00",
      null,
    ]);
  });

  it("refuses a replacement the warehouse does not have", async () => {
    await expect(
      damage({
        damaged: [{ productId: t.chips.id, quantity: "1" }],
        replacements: [{ productId: t.nimko.id, quantity: "5" }],
      }),
    ).rejects.toThrow(/Not enough stock/);
    expect(await t.ctx.db.damageReturn.count()).toBe(0);
  });

  it("is cancelled by reversal, not once the damaged stock went back to the company", async () => {
    const a = await damage({
      damaged: [{ productId: t.chips.id, quantity: "1" }],
      replacements: [{ productId: t.nimko.id, quantity: "0.5" }],
    });
    await reverseDamageReturn(t.ctx, { id: a.id, reason: "wrong customer" });
    expect(await owes()).toBe("1000.00");
    expect([await stock(t.chips.id, "DAMAGED"), await stock(t.nimko.id, "SALEABLE")]).toEqual([
      0, 24,
    ]);
    const view = await getDamageReturn(t.ctx, a.id);
    expect([view.status, view.claims[0]!.status]).toEqual(["REVERSED", "REVERSED"]);
    await expect(reverseDamageReturn(t.ctx, { id: a.id, reason: "again" })).rejects.toThrow(
      /already cancelled/,
    );

    const b = await damage({ damaged: [{ productId: t.chips.id, quantity: "6pk" }] });
    await returnDamagedStock(t.ctx, { productId: t.chips.id, quantity: "6pk", returnDate: DAY });
    await expect(reverseDamageReturn(t.ctx, { id: b.id, reason: "late" })).rejects.toThrow(
      /already sent back/,
    );
  });

  it("retries never post twice, and it needs operations access", async () => {
    const requestId = randomUUID();
    const input = { requestId, damaged: [{ productId: t.chips.id, quantity: "6pk" }] };
    const first = await damage(input);
    expect((await damage(input)).id).toBe(first.id);
    expect(await owes()).toBe("888.00");
    const platform: ServiceCtx = { ...t.ctx, user: { ...t.ctx.user, role: "SUPER_ADMIN" } };
    await expect(damage(input, platform)).rejects.toThrow(ForbiddenError);
  });
});
