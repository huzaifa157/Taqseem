import { redirect } from "next/navigation";

/** Receiving goods is now part of a purchase (goods in + payment, in one step). */
export default function NewGoodsReceiptPage() {
  redirect("/purchases/new");
}
