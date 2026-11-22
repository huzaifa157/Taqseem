import { describe, expect, it } from "vitest";

import {
  billTotals,
  canTransition,
  checkCredit,
  isOpenOrder,
  minimumPayment,
  priceLine,
  priceLineFor,
  readCustomerDiscount,
  readSpecialDiscount,
  splitSpecialDiscount,
} from "./sales";

const chips = {
  id: "p1",
  companyId: "c1",
  saleRate: "228",
  discountType: "AMOUNT_PER_UNIT" as const,
  discountValue: "4",
  tiers: [{ minQuantity: 300, discountType: "AMOUNT_PER_UNIT" as const, discountValue: "8" }],
};
const nimko = {
  id: "p2",
  companyId: "c2",
  saleRate: "230",
  discountType: "NONE" as const,
  discountValue: "0",
  tiers: [],
};

describe("priceLine", () => {
  it("applies the company discount per dozen", () => {
    const line = priceLine(chips, 42); // 3.5 dz
    expect([
      line.grossAmount.toFixed(2),
      line.discountAmount.toFixed(2),
      line.netAmount.toFixed(2),
    ]).toEqual(["798.00", "14.00", "784.00"]);
    expect(line).toMatchObject({ companyId: "c1", discountType: "AMOUNT_PER_UNIT" });
  });

  it("switches to the slab the quantity reaches, for the whole line", () => {
    const line = priceLine(chips, 300); // 25 dz
    expect([line.discountValue.toFixed(2), line.netAmount.toFixed(2)]).toEqual(["8.00", "5500.00"]);
  });

  it("prices loose packets at the per-dozen rate", () => {
    const line = priceLine(nimko, 5); // 5 packets of 230 / dozen
    expect(line.netAmount.toFixed(2)).toBe("95.83");
  });
});

describe("priceLineFor (a customer's own discount)", () => {
  it("keeps the fixed rate and uses the customer's discount in place of the product's and slabs", () => {
    const line = priceLineFor(chips, 300, "20"); // 25 dz: the slab (8) would apply, the customer's 20 does
    expect([
      line.rate.toFixed(2),
      line.discountValue.toFixed(2),
      line.discountAmount.toFixed(2),
      line.netAmount.toFixed(2),
    ]).toEqual(["228.00", "20.00", "500.00", "5200.00"]);
    expect(line).toMatchObject({ discountType: "AMOUNT_PER_UNIT", customerDiscount: true });
  });

  it("a zero discount is the customer's own too (no product discount)", () => {
    const line = priceLineFor(chips, 42, "0");
    expect([line.netAmount.toFixed(2), line.customerDiscount]).toEqual(["798.00", true]);
  });

  it("no customer discount prices normally", () => {
    for (const discount of [null, undefined, ""]) {
      const line = priceLineFor(chips, 42, discount);
      expect([line.netAmount.toFixed(2), line.customerDiscount]).toEqual(["784.00", undefined]);
    }
  });
});

describe("readCustomerDiscount", () => {
  it("reads rupees per dozen, blank as none, and refuses more than the rate", () => {
    expect(readCustomerDiscount(" 1,25.5 ", "228").discount?.toFixed(2)).toBe("125.50");
    expect(readCustomerDiscount("", "228")).toEqual({ discount: null });
    expect(readCustomerDiscount("229", "228").error).toBe("Discount: cannot be more than the rate");
    expect(readCustomerDiscount("-5", "228").error).toMatch(/a number of rupees/);
  });
});

describe("billTotals", () => {
  it("totals the bill and each company's slice", () => {
    const lines = [priceLine(chips, 24), priceLine(nimko, 18), priceLine(chips, 12)];
    const { total, byCompany } = billTotals(lines);
    expect([total.netAmount.toFixed(2), total.quantity]).toEqual(["1017.00", 54]);
    expect(byCompany.get("c1")!.netAmount.toFixed(2)).toBe("672.00");
    expect(byCompany.get("c2")!.netAmount.toFixed(2)).toBe("345.00");
  });
});

describe("special discount on the whole bill", () => {
  const lines = [priceLine(chips, 24), priceLine(nimko, 18), priceLine(chips, 12)];

  it("comes off each company's slice by its share and adds up exactly", () => {
    // 672 and 345 of 1017: 100 splits 66.07 + 33.92, the paisa left over to the larger.
    const { total, byCompany } = billTotals(lines, "100");
    expect(total.netAmount.toFixed(2)).toBe("917.00");
    expect(total.specialDiscount.toFixed(2)).toBe("100.00");
    expect(byCompany.get("c1")!.specialDiscount.toFixed(2)).toBe("66.08");
    expect(byCompany.get("c2")!.specialDiscount.toFixed(2)).toBe("33.92");
    expect(byCompany.get("c1")!.netAmount.add(byCompany.get("c2")!.netAmount).toFixed(2)).toBe(
      "917.00",
    );
    // Counted in the discount: gross − discount = net still holds.
    expect(total.grossAmount.sub(total.discountAmount).toFixed(2)).toBe("917.00");
  });

  it("is never more than the bill, and nothing when blank", () => {
    expect(billTotals(lines, "5000").total.netAmount.toFixed(2)).toBe("0.00");
    expect(billTotals(lines).total.specialDiscount.toFixed(2)).toBe("0.00");
    expect(splitSpecialDiscount(new Map(), "50").size).toBe(0);
  });

  it("reads what was typed", () => {
    expect(readSpecialDiscount("", "1000").discount.toFixed(2)).toBe("0.00");
    expect(readSpecialDiscount("1,50", "1000").discount.toFixed(2)).toBe("150.00");
    expect(readSpecialDiscount("abc", "1000").error).toMatch(/rupees/);
    expect(readSpecialDiscount("1001", "1000").error).toMatch(/more than the bill/);
  });
});

describe("checkCredit", () => {
  it("counts pending, other open orders and this order", () => {
    const check = checkCredit({
      creditLimit: "25000",
      pending: "18000",
      openOrders: "4000",
      thisOrder: "5000",
    });
    expect(check.exposure.toFixed(2)).toBe("27000.00");
    expect(check.over?.toFixed(2)).toBe("2000.00");
  });

  it("no limit, or within it, is fine; an empty order never warns", () => {
    expect(
      checkCredit({ creditLimit: null, pending: "999999", openOrders: "0", thisOrder: "1" }).over,
    ).toBeNull();
    expect(
      checkCredit({ creditLimit: "25000", pending: "20000", openOrders: "0", thisOrder: "5000" })
        .over,
    ).toBeNull();
    expect(
      checkCredit({ creditLimit: "100", pending: "500", openOrders: "0", thisOrder: "0" }).over,
    ).toBeNull();
  });
});

describe("order statuses", () => {
  it("follows Booked → Planned → Dispatched → Delivered / Partly delivered / Returned", () => {
    expect(canTransition("BOOKED", "PLANNED")).toBe(true);
    expect(canTransition("PLANNED", "DISPATCHED")).toBe(true);
    expect(canTransition("DISPATCHED", "PARTIALLY_DELIVERED")).toBe(true);
    expect(canTransition("DISPATCHED", "CANCELLED")).toBe(false);
    expect(canTransition("DELIVERED", "BOOKED")).toBe(false);
    expect([isOpenOrder("BOOKED"), isOpenOrder("PLANNED"), isOpenOrder("DISPATCHED")]).toEqual([
      true,
      true,
      false,
    ]);
  });
});

describe("minimumPayment", () => {
  const min = (previous: string, totalDue: string, creditLimit: string | null) =>
    minimumPayment({ previous, totalDue, creditLimit }).toFixed(2);

  it("is the earlier balance when the total stays within the limit", () => {
    expect(min("5000", "12000", "20000")).toBe("5000.00");
  });
  it("is what brings the total back within the limit when that is more", () => {
    expect(min("5000", "32000", "20000")).toBe("12000.00");
  });
  it("is the earlier balance when there is no credit limit", () => {
    expect(min("5000", "32000", null)).toBe("5000.00");
  });
  it("is the whole total with a zero limit", () => {
    expect(min("5000", "8000", "0")).toBe("8000.00");
  });
  it("is never negative (advance in hand)", () => {
    expect(min("-3000", "2000", "10000")).toBe("0.00");
  });
});
