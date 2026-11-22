"use client";

import { useSyncExternalStore } from "react";

import { cn } from "@/lib/utils";

// The colour theme (globals.css): kept in this browser, like the sidebar's collapsed state — a
// convenience per computer, not data. Set on <html> as data-theme before the first paint
// (THEME_INIT_SCRIPT in the root layout), so a page never flashes the wrong colours.

const KEY = "taqseem.theme";

export const THEMES = [
  {
    id: "taqseem",
    label: "Taqseem",
    hint: "White with the Taqseem green",
    swatch: "bg-[oklch(0.45_0.09_165)]",
  },
  {
    id: "mono",
    label: "Black & white",
    hint: "Ink on paper: black and white only",
    swatch: "bg-[linear-gradient(135deg,#141414_50%,#ffffff_50%)]",
  },
  {
    id: "black",
    label: "Black",
    hint: "Dark, for evening work",
    swatch: "bg-[#141414] ring-1 ring-inset ring-white/25",
  },
] as const;

export type ThemeId = (typeof THEMES)[number]["id"];

/** Applies the saved theme before the first paint (inline in <head>). */
export const THEME_INIT_SCRIPT = `try{var t=localStorage.getItem(${JSON.stringify(KEY)});if(t==="mono"||t==="black"){document.documentElement.dataset.theme=t}}catch(e){}`;

const listeners = new Set<() => void>();
function subscribe(onChange: () => void) {
  listeners.add(onChange);
  return () => listeners.delete(onChange);
}
function current(): ThemeId {
  const t = document.documentElement.dataset.theme;
  return t === "mono" || t === "black" ? t : "taqseem";
}

function apply(id: ThemeId) {
  const root = document.documentElement;
  if (id === "taqseem") delete root.dataset.theme;
  else root.dataset.theme = id;
  try {
    localStorage.setItem(KEY, id);
  } catch {
    // Private window or storage blocked: it just won't be remembered.
  }
  for (const l of listeners) l();
}

export function ThemePicker() {
  const theme = useSyncExternalStore(subscribe, current, () => "taqseem" as ThemeId);
  const active = THEMES.find((t) => t.id === theme) ?? THEMES[0];
  return (
    <div
      title={`Theme: ${active.label}`}
      className="flex items-center justify-between gap-2 group-data-[collapsed=true]/sidebar:justify-center max-md:justify-center"
    >
      <span className="text-muted-foreground text-xs group-data-[collapsed=true]/sidebar:sr-only max-md:sr-only">
        Theme
      </span>
      <div
        role="radiogroup"
        aria-label="Colour theme"
        className="flex items-center gap-1.5 group-data-[collapsed=true]/sidebar:flex-col max-md:flex-col"
      >
        {THEMES.map((t) => {
          const on = t.id === theme;
          return (
            <button
              key={t.id}
              type="button"
              role="radio"
              aria-checked={on}
              aria-label={t.label}
              title={`${t.label}: ${t.hint}`}
              onClick={() => apply(t.id)}
              className={cn(
                "focus-visible:ring-sidebar-ring grid size-5 place-items-center rounded-full outline-none focus-visible:ring-2",
                on && "ring-sidebar-foreground ring-offset-sidebar ring-2 ring-offset-2",
              )}
            >
              <span
                aria-hidden
                className={cn("border-sidebar-foreground/20 size-5 rounded-full border", t.swatch)}
              />
            </button>
          );
        })}
      </div>
    </div>
  );
}
