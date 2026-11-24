import { redirect } from "next/navigation";

/** Purchases open on the list of purchases (goods received with their bills). */
export default function PurchasesPage() {
  redirect("/purchases/receipts");
}
