import {
  Banknote,
  BarChart3,
  BookOpen,
  Boxes,
  Building2,
  LayoutDashboard,
  Package,
  PackagePlus,
  PackageX,
  type LucideIcon,
  Receipt,
  Settings,
  ShoppingBag,
  ShoppingCart,
  Truck,
  Users,
  Wallet,
} from "lucide-react";

import type { Permission } from "@/server/auth/permissions";

export type NavItem = {
  title: string;
  href: string;
  icon: LucideIcon;
  /** Shown only to roles with this permission (the page checks it again on the server). */
  permission?: Permission;
  /** false: no Alt+number, so the sections after it keep the shortcuts people already know. */
  shortcut?: false;
  /** Alt+letter instead (for items without a number), e.g. "C" for Counter sale. */
  letter?: string;
};

export const navItems: NavItem[] = [
  { title: "Dashboard", href: "/dashboard", icon: LayoutDashboard },
  {
    title: "Counter sale",
    href: "/orders/counter",
    icon: ShoppingBag,
    permission: "operations.manage",
    shortcut: false,
    letter: "C",
  },
  { title: "Orders", href: "/orders", icon: ShoppingCart },
  { title: "Delivery", href: "/delivery", icon: Truck },
  { title: "Purchases", href: "/purchases", icon: PackagePlus },
  { title: "Inventory", href: "/inventory", icon: Boxes },
  {
    title: "Damage",
    href: "/damage",
    icon: PackageX,
    permission: "operations.manage",
    // No Alt+number: the sections after it keep the shortcuts people already know.
    shortcut: false,
  },
  { title: "Customers", href: "/customers", icon: Users },
  { title: "Companies", href: "/companies", icon: Building2 },
  { title: "Products", href: "/products", icon: Package },
  { title: "Payments", href: "/payments", icon: Wallet, permission: "payments.manage" },
  {
    title: "Cash book",
    href: "/cash",
    icon: Banknote,
    permission: "payments.manage",
    // No Alt+number: the sections after it keep the shortcuts people already know.
    shortcut: false,
  },
  { title: "Ledgers", href: "/ledgers", icon: BookOpen, permission: "ledgers.view" },
  { title: "Expenses", href: "/expenses", icon: Receipt, permission: "expenses.manage" },
  { title: "Reports", href: "/reports", icon: BarChart3 },
  { title: "Settings", href: "/settings", icon: Settings, permission: "settings.manage" },
];
