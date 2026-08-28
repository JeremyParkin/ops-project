"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";

type NavMenuProps = {
  label: ReactNode;
  triggerAriaLabel?: string;
  active?: boolean;
  align?: "left" | "right";
  triggerClassName?: string;
  panelClassName?: string;
  showCaret?: boolean;
  children: ReactNode;
};

// A click-to-open navigation disclosure (WAI-ARIA "disclosure" pattern, not
// an application menu): the trigger is a plain button with aria-expanded/
// aria-controls, and the panel just holds ordinary links/buttons in a
// labeled group. Deliberately does not use role="menu"/"menuitem" — this
// component only opens a region of navigation links, not a widget with
// full arrow-key/type-ahead menu keyboard behavior, so claiming the menu
// role would promise interaction patterns it doesn't implement. Escape
// closes and returns focus to the trigger; an outside click closes; Tab
// moves through the panel's contents in DOM order. Route-change close is
// handled by the caller remounting via `key={pathname}` rather than an
// effect, so navigating always starts from a fresh, closed panel without a
// setState-in-effect cascade.
export function NavMenu({
  label,
  triggerAriaLabel,
  active,
  align = "left",
  triggerClassName,
  panelClassName,
  showCaret = true,
  children,
}: NavMenuProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) {
      return;
    }

    function handlePointerDown(event: MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    }

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);

    const firstItem = panelRef.current?.querySelector<HTMLElement>(
      "a[href], button:not([disabled])",
    );
    firstItem?.focus();

    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        aria-expanded={open}
        aria-controls={menuId}
        aria-label={triggerAriaLabel}
        onClick={() => setOpen((current) => !current)}
        className={
          triggerClassName ??
          `flex items-center gap-1 px-3 py-2 text-sm font-medium ${
            active
              ? "bg-brass text-graphite"
              : "text-grit-light hover:bg-slab hover:text-chalk"
          }`
        }
      >
        {label}
        {showCaret ? (
          <span aria-hidden="true" className="text-[10px]">
            ▾
          </span>
        ) : null}
      </button>
      {open ? (
        <div
          ref={panelRef}
          id={menuId}
          role="group"
          aria-label={typeof label === "string" ? label : undefined}
          className={
            panelClassName ??
            `absolute z-30 mt-1 max-h-[70vh] min-w-56 overflow-y-auto border border-slab bg-graphite py-1 shadow-lg ${
              align === "right" ? "right-0" : "left-0"
            }`
          }
        >
          {children}
        </div>
      ) : null}
    </div>
  );
}
