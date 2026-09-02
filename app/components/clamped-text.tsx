"use client";

import { useEffect, useRef, useState } from "react";

// Ordinary long text values (e.g. a Notes field) clamp to 2 lines by
// default so a single row can't blow out the table's row height. "More" is
// a separate control from whatever opens inline-edit on this cell (see
// EditableTableCell) -- it never shares a click target with edit-entry.
//
// Truncation is detected with the standard scrollHeight-vs-clientHeight
// comparison against the clamped element, once after mount: a genuinely
// two-line-or-shorter value never shows "More" at all. This only runs while
// still clamped (the effect depends on `text`, not `isExpanded`), so
// expanding doesn't re-measure against the now-unclamped height and hide
// the control it's currently showing. Re-checked on window resize since a
// narrower viewport can turn a previously two-line value into a truncated
// one; there's no per-column resize in this table (deferred), so a plain
// resize listener is enough -- no ResizeObserver needed.
export function ClampedText({ text, className = "" }: { text: string; className?: string }) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [isTruncated, setIsTruncated] = useState(false);
  const textRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const element = textRef.current;

    if (!element) {
      return;
    }

    function measure() {
      if (!element) {
        return;
      }
      setIsTruncated(element.scrollHeight > element.clientHeight + 1);
    }

    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [text]);

  return (
    <span className={`block ${className}`}>
      <span ref={textRef} className={isExpanded ? "" : "line-clamp-2"}>
        {text}
      </span>
      {isTruncated ? (
        <button
          type="button"
          onClick={() => setIsExpanded((current) => !current)}
          aria-expanded={isExpanded}
          className="mt-0.5 block text-xs font-medium text-stone underline-offset-4 hover:text-graphite hover:underline"
        >
          {isExpanded ? "Less" : "More"}
        </button>
      ) : null}
    </span>
  );
}
