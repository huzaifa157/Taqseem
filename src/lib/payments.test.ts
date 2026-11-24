import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";

import { allocateOldestFirst, type BillDebt, effectiveDebt } from "./payments";

const D = (v: Decimal | string | number) => new Decimal(v).toFixed(2);
const allocs = (a: { billId: string; amount: Decimal }[]) =>
  a.map((x) => `${x.billId}=${x.amount.toFixed(2)}`);

// Bill 1 (older) 1000 unpaid, bill 2 1000 unpaid.
const bills: BillDebt[] = [
  { billId: "b1", number: 1, outstanding: "1000" },
  { billId: "b2", number: 2, outstanding: "1000" },
];

describe("what the customer owes, bill by bill", () => {
  it("treats a balance above the open bills as old / opening balance", () => {
    const d = effectiveDebt("2300", bills);
    expect(D(d.unbilled)).toBe("300.00");
    expect(d.bills.map((b) => D(b.outstanding))).toEqual(["1000.00", "1000.00"]);
  });

  it("uses an earlier advance or return to pay off the oldest bills", () => {
    const d = effectiveDebt("1300", bills);
    expect(D(d.unbilled)).toBe("0.00");
    expect(d.bills.map((b) => [b.billId, D(b.outstanding)])).toEqual([
      ["b1", "300.00"],
      ["b2", "1000.00"],
    ]);
  });

  it("owes nothing on bills when the balance is an advance", () => {
    expect(effectiveDebt("-500", bills).bills).toEqual([]);
  });
});

describe("oldest debt first", () => {
  it("pays the old balance, then the oldest bill in full, then part of the next", () => {
    const s = allocateOldestFirst("1500", effectiveDebt("2300", bills));
    expect(D(s.unbilled)).toBe("300.00");
    expect(allocs(s.allocations)).toEqual(["b1=1000.00", "b2=200.00"]);
    expect(D(s.advance)).toBe("0.00");
  });

  it("keeps what is left over as an advance", () => {
    const s = allocateOldestFirst("2500", effectiveDebt("2000", bills));
    expect(allocs(s.allocations)).toEqual(["b1=1000.00", "b2=1000.00"]);
    expect(D(s.advance)).toBe("500.00");
  });

  it("is all advance when nothing is owed", () => {
    const s = allocateOldestFirst("700", effectiveDebt("0", []));
    expect(s.allocations).toEqual([]);
    expect(D(s.advance)).toBe("700.00");
  });
});
