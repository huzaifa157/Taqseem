import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { orNotFound } from "@/components/master/page-helpers";
import { OrderEntry } from "@/components/sales/order-entry";
import { toDateInput } from "@/lib/dates";
import { isOpenOrder } from "@/lib/sales";
import { quantityText } from "@/lib/units";
import { can } from "@/server/auth/permissions";
import { requireTenantContext } from "@/server/auth/session";
import { correctCounterSaleAction, saveSalesOrderAction } from "@/server/sales-actions";
import { warehouseOptions } from "@/server/services/master/warehouses";
import { counterSaleDamage } from "@/server/services/sales/counter";
import { customersForOrders, getSalesOrder } from "@/server/services/sales/orders";
import { addToBalanceAction } from "@/server/payment-actions";

export const metadata: Metadata = { title: "Edit order" };

export default async function EditOrderPage({ params }: PageProps<"/orders/[id]/edit">) {
  const { id } = await params;
  const ctx = await requireTenantContext("operations.manage");
  const [order, customers, warehouses] = await Promise.all([
    orNotFound(getSalesOrder(ctx, id)),
    customersForOrders(ctx),
    warehouseOptions(ctx),
  ]);
  // A saved counter sale can still be corrected (and its bill printed again); an order only until
  // dispatch.
  const counter = order.fulfilment === "COUNTER" && order.status === "DELIVERED";
  if (!counter && !isOpenOrder(order.status)) redirect(`/orders/${id}`);
  const payment = order.payments[0];
  // Damage already deducted from this sale: shown in "− Damage" so it can be corrected too.
  const damage = counter ? await counterSaleDamage(ctx, id) : null;
  return (
    <>
      <OrderEntry
        header={
          counter
            ? {
                backHref: `/orders/${id}`,
                backLabel: `Counter sale #${order.number}`,
                title: `Correct counter sale #${order.number}`,
                description:
                  "Fix the items, dozens, discount or payment. The bill keeps its number and gets a new revision; stock and the customer ledger are corrected with reversal entries.",
              }
            : {
                backHref: `/orders/${id}`,
                backLabel: `Order #${order.number}`,
                title: `Edit order #${order.number}`,
                description: "Changes are kept as a new bill revision.",
              }
        }
        mode={counter ? "counter" : "order"}
        action={
          counter ? correctCounterSaleAction.bind(null, id) : saveSalesOrderAction.bind(null, id)
        }
        customers={
          customers.some((c) => c.id === order.customerId)
            ? customers
            : [
                ...customers,
                {
                  id: order.customerId,
                  name: order.customer.name,
                  shopName: order.customer.shopName,
                  phone: order.customer.phone,
                  area: order.customer.area
                    ? { name: order.customer.area.name, warehouseId: order.warehouseId }
                    : null,
                },
              ]
        }
        warehouses={warehouses}
        canOverrideCredit={can(ctx.user.role, "orders.overrideCreditLimit")}
        addToBalance={can(ctx.user.role, "payments.manage") ? addToBalanceAction : undefined}
        initial={{
          orderId: id,
          customerId: order.customerId,
          warehouseId: order.customer.areaId ? undefined : order.warehouseId,
          orderDate: toDateInput(order.orderDate),
          deliveryDate: toDateInput(order.deliveryDate),
          source: order.source,
          note: order.note ?? undefined,
          specialDiscount: order.specialDiscount.gt(0) ? order.specialDiscount.toFixed(2) : "",
          payment:
            counter && order.payments.length === 1 && payment
              ? {
                  amount: payment.amount.toFixed(2),
                  method: payment.method,
                  reference: payment.reference ?? "",
                  chequeNo: payment.cheque?.chequeNo ?? "",
                  bankName: payment.cheque?.bankName ?? "",
                  chequeDate: payment.cheque ? toDateInput(payment.cheque.chequeDate) : "",
                  // Paid the whole bill: "Full" stays on, so the payment follows a corrected total.
                  full: order.bill
                    ? payment.amount.eq(order.bill.netAmount.sub(damage?.amount ?? 0))
                    : false,
                }
              : undefined,
          lines: order.lines.map((l) => ({
            productId: l.productId,
            qty: quantityText(l.quantity),
            // The customer's discount this order has (blank: the product's own discount applied).
            // A rate changed on an older order is not kept: rates are fixed now.
            discount: l.customerDiscount ? l.discountValue.toFixed(2) : "",
          })),
          damage: damage?.lines.map((l) => ({
            productId: l.productId,
            qty: quantityText(l.quantity),
            rate: l.rate.toFixed(2),
          })),
        }}
      />
    </>
  );
}
