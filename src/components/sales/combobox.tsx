"use client";

import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

/**
 * Keyboard-first search box with a pick list: type to filter, ↑/↓ to move, Enter to pick, Esc to
 * close. With one match, Enter picks it straight away.
 */
export function Combobox<T>({
  label,
  items,
  getKey,
  render,
  rank,
  onSelect,
  placeholder,
  inputRef,
  autoFocus,
  emptyText = "No matches",
  limit = 8,
  hint,
  onNoMatch,
  noMatchLabel,
  isExact,
  hideLabel = false,
  inputClassName,
  labelClassName,
  onInputKeyDown,
  floating = false,
}: {
  label: string;
  items: T[];
  getKey: (item: T) => string;
  render: (item: T) => React.ReactNode;
  /** 0 = no match; higher ranks first. */
  rank: (item: T, query: string) => number;
  onSelect: (item: T) => void;
  placeholder?: string;
  inputRef?: React.Ref<HTMLInputElement>;
  autoFocus?: boolean;
  emptyText?: string;
  limit?: number;
  hint?: string;
  /**
   * "Add new" with what was typed: offered when nothing matches, and also, under the matches,
   * when none of them is exactly what was typed (see isExact). Enter or a click calls it.
   */
  onNoMatch?: (query: string) => void;
  noMatchLabel?: (query: string) => string;
  /** Whether an item is exactly what was typed (lower case, trimmed); then no "add new" is offered. */
  isExact?: (item: T, query: string) => boolean;
  /** In a table cell: the label is read out but not shown. */
  hideLabel?: boolean;
  inputClassName?: string;
  labelClassName?: string;
  /** Keys the box does not use itself (e.g. moving between cells of a sheet). */
  onInputKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>, listOpen: boolean) => void;
  /**
   * Draw the list over the whole page, under the box, instead of inside its container: for a box
   * in a table cell or a scrolling area, where rows painted later or the container's edge would
   * cover or cut off the list.
   */
  floating?: boolean;
}) {
  const id = useId();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [place, setPlace] = useState<React.CSSProperties | null>(null);
  // Closing on blur waits a moment so a click on the list still lands.
  const closeTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  /** Where the floating list goes: under the box, or above it when there is more room there. */
  const measure = () => {
    const el = floating ? document.getElementById(`${id}-input`) : null;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const below = window.innerHeight - r.bottom - 8;
    const above = r.top - 8;
    const up = below < 200 && above > below;
    setPlace({
      position: "fixed",
      left: Math.max(4, Math.min(r.left, window.innerWidth - Math.max(r.width, 320) - 4)),
      width: Math.max(r.width, 320),
      maxHeight: Math.min(320, up ? above : below),
      ...(up ? { bottom: window.innerHeight - r.top + 4 } : { top: r.bottom + 4 }),
    });
  };

  const q = query.trim().toLowerCase();
  const results = (
    q
      ? items
          .map((item) => ({ item, score: rank(item, q) }))
          .filter((r) => r.score > 0)
          .sort((a, b) => b.score - a.score)
          .map((r) => r.item)
      : items
  ).slice(0, limit);
  const showList = open && q.length > 0;
  // "Add new" comes after the matches (it is the only option when there are none).
  const offerNew = Boolean(
    onNoMatch && q && (results.length === 0 || (isExact && !items.some((i) => isExact(i, q)))),
  );
  const newIndex = results.length;
  const optionCount = results.length + (offerNew ? 1 : 0);
  const addNew = () => {
    onNoMatch?.(query.trim());
    setQuery("");
    setOpen(false);
    setActive(0);
  };
  // Keep the floating list with its box while the page or the sheet scrolls.
  useEffect(() => {
    if (!floating || !showList) return;
    const follow = () => measure();
    window.addEventListener("scroll", follow, true);
    window.addEventListener("resize", follow);
    return () => {
      window.removeEventListener("scroll", follow, true);
      window.removeEventListener("resize", follow);
    };
  });

  const pick = (item: T) => {
    onSelect(item);
    setQuery("");
    setOpen(false);
    setActive(0);
  };

  return (
    <div className="relative space-y-1.5">
      <Label htmlFor={`${id}-input`} className={cn(labelClassName, hideLabel && "sr-only")}>
        {label}
      </Label>
      <Input
        id={`${id}-input`}
        ref={inputRef}
        role="combobox"
        aria-expanded={showList}
        aria-controls={`${id}-list`}
        aria-autocomplete="list"
        aria-activedescendant={showList && active < optionCount ? `${id}-opt-${active}` : undefined}
        aria-describedby={hint ? `${id}-hint` : undefined}
        autoComplete="off"
        className={inputClassName}
        autoFocus={autoFocus}
        placeholder={placeholder}
        value={query}
        onChange={(e) => {
          clearTimeout(closeTimer.current);
          setQuery(e.target.value);
          setOpen(true);
          setActive(0);
          measure();
        }}
        onFocus={() => {
          // Back in the box before the last blur's close ran (fast typing): keep the list open.
          clearTimeout(closeTimer.current);
          setOpen(true);
          measure();
        }}
        onBlur={() => {
          closeTimer.current = setTimeout(() => setOpen(false), 150);
        }}
        onKeyDown={(e) => {
          onInputKeyDown?.(e, showList);
          if (e.defaultPrevented) return;
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setOpen(true);
            setActive((a) => Math.min(a + 1, optionCount - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive((a) => Math.max(a - 1, 0));
          } else if (e.key === "Enter" && !e.ctrlKey && !e.metaKey) {
            e.preventDefault();
            const item = results[active];
            if (showList && item) pick(item);
            else if (showList && offerNew && active === newIndex) addNew();
          } else if (e.key === "Escape") {
            // Something to close or clear: this Esc is used up. Otherwise the website's Esc
            // applies (leave the box, then back).
            if (query || showList) e.preventDefault();
            setOpen(false);
            setQuery("");
          }
        }}
      />
      {hint ? (
        <p id={`${id}-hint`} className="text-muted-foreground text-xs">
          {hint}
        </p>
      ) : null}
      {showList ? (
        <Floating on={floating}>
          <ul
            id={`${id}-list`}
            role="listbox"
            aria-label={label}
            style={floating && place ? place : undefined}
            className={cn(
              "bg-popover overflow-auto rounded-md border py-1 shadow-md",
              floating ? "z-50" : "absolute z-20 mt-1 max-h-80 w-full",
            )}
          >
            {results.length === 0 && !offerNew ? (
              <li className="text-muted-foreground px-3 py-2 text-sm">{emptyText}</li>
            ) : null}
            {results.map((item, i) => (
              <li
                key={getKey(item)}
                id={`${id}-opt-${i}`}
                role="option"
                aria-selected={i === active}
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(item);
                }}
                onMouseEnter={() => setActive(i)}
                className={cn(
                  "cursor-pointer px-3 py-1.5 text-sm",
                  i === active && "bg-accent text-accent-foreground",
                )}
              >
                {render(item)}
              </li>
            ))}
            {offerNew ? (
              <li
                id={`${id}-opt-${newIndex}`}
                role="option"
                aria-selected={active === newIndex}
                onMouseDown={(e) => {
                  e.preventDefault();
                  addNew();
                }}
                onMouseEnter={() => setActive(newIndex)}
                className={cn(
                  "cursor-pointer px-3 py-2 text-sm font-medium",
                  results.length > 0 && "border-t",
                  active === newIndex && "bg-accent text-accent-foreground",
                )}
              >
                {noMatchLabel ? noMatchLabel(query.trim()) : emptyText}
              </li>
            ) : null}
          </ul>
        </Floating>
      ) : null}
    </div>
  );
}

/** The floating list goes straight into the page body, above everything else. */
function Floating({ on, children }: { on: boolean; children: React.ReactNode }) {
  return on ? createPortal(children, document.body) : children;
}

/**
 * Ranking for code/name search: exact code > code prefix > word prefix > contains. Several words
 * must each match somewhere, in any order ("kh ali" finds Ali Khan); the weakest word decides.
 * `query` is lower case.
 */
export function rankText(
  query: string,
  code: string | null,
  ...texts: (string | null | undefined)[]
): number {
  const words = query.split(/\s+/).filter(Boolean);
  if (words.length > 1) {
    const whole = rankWord(query, code, texts);
    const each = Math.min(...words.map((w) => rankWord(w, code, texts)));
    return Math.max(whole, each);
  }
  return rankWord(query, code, texts);
}

function rankWord(query: string, code: string | null, texts: (string | null | undefined)[]) {
  const c = (code ?? "").toLowerCase();
  if (c && c === query) return 100;
  if (c && c.startsWith(query)) return 80;
  let best = 0;
  for (const t of texts) {
    const text = (t ?? "").toLowerCase();
    if (!text) continue;
    if (text.startsWith(query)) best = Math.max(best, 60);
    else if (text.split(/\s+/).some((w) => w.startsWith(query))) best = Math.max(best, 40);
    else if (text.includes(query)) best = Math.max(best, 20);
  }
  return best;
}
