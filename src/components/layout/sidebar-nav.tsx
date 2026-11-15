"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { Kbd } from "@/components/ui/kbd";
import { cn } from "@/lib/utils";

import { navItems } from "./nav-items";

/** `visibleHrefs` comes from the server (role-filtered); icons stay on the client. */
export function SidebarNav({ visibleHrefs }: { visibleHrefs: readonly string[] }) {
  return <NavList visibleHrefs={visibleHrefs} pathname={usePathname()} />;
}

/**
 * The same list without reading the URL, for the prerendered shell (on dynamic routes like
 * /customers/[id] the URL is not known at build time).
 */
export function NavList({
  visibleHrefs,
  pathname,
}: {
  visibleHrefs: readonly string[];
  pathname?: string;
}) {
  const items = navItems.filter((item) => visibleHrefs.includes(item.href));
  // The most specific match is the active one (/orders/counter is Counter sale, not Orders).
  const activeHref =
    pathname === undefined
      ? undefined
      : items
          .filter((item) => pathname === item.href || pathname.startsWith(`${item.href}/`))
          .sort((a, b) => b.href.length - a.href.length)[0]?.href;
  let numbered = 0;
  return (
    <nav aria-label="Main" className="flex min-h-0 flex-col gap-0.5 overflow-y-auto p-2">
      {items.map((item) => {
        // Alt+1 … Alt+9, Alt+0 open the first ten numbered sections (keyboard-shortcuts.tsx).
        const index = item.shortcut === false ? null : numbered++;
        const key =
          index === null ? null : index < 9 ? String(index + 1) : index === 9 ? "0" : null;
        const active = item.href === activeHref;
        const Icon = item.icon;
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            aria-keyshortcuts={key ? `Alt+${key}` : undefined}
            data-nav-key={key ?? undefined}
            title={key ? `${item.title} (Alt+${key})` : item.title}
            className={cn(
              "text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-sidebar-ring flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium outline-none group-data-[collapsed=true]/sidebar:justify-center group-data-[collapsed=true]/sidebar:px-0 focus-visible:ring-2 max-md:justify-center max-md:px-0",
              active && "bg-sidebar-accent text-sidebar-accent-foreground",
            )}
          >
            <Icon className="size-4 shrink-0" aria-hidden />
            <span className="truncate group-data-[collapsed=true]/sidebar:sr-only max-md:sr-only">
              {item.title}
            </span>
            {key ? (
              <Kbd className="ml-auto group-data-[collapsed=true]/sidebar:hidden max-md:hidden">
                Alt+{key}
              </Kbd>
            ) : null}
          </Link>
        );
      })}
    </nav>
  );
}
