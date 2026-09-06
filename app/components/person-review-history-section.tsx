import Link from "next/link";
import { ChoicePill } from "@/app/components/choice-pill";
import { CollapsibleSection } from "@/app/components/page-primitives";
import type { PersonQualityReviewHistoryEntry } from "@/lib/domain/quality-review-repository";

function formatReviewDate(reviewDate: string) {
  // reviewDate is a canonical YYYY-MM-DD string from the RPC -- parsed as a
  // local calendar date, not a UTC instant, so it never shifts a day
  // depending on the viewer's timezone.
  const [year, month, day] = reviewDate.split("-").map(Number);
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(year, month - 1, day));
}

// Phase 12.3.2: the purposeful Review History section for a Person record.
// Finalized-only (guaranteed by the RPC, not re-checked here), complete and
// uncapped, newest Review Date first. Notes/content are never returned by
// the RPC, so there is nothing here to accidentally render beyond Date,
// Result, Reviewer, and a link to the full review.
export function PersonReviewHistorySection({
  entries,
  personEntityTypeId,
}: {
  entries: PersonQualityReviewHistoryEntry[];
  personEntityTypeId: string;
}) {
  if (entries.length === 0) {
    return null;
  }

  const distinctTypeCount = new Set(entries.map((entry) => entry.reviewEntityTypeId)).size;
  const showTypeLabel = distinctTypeCount > 1;

  return (
    <CollapsibleSection title="Review history">
      <ul role="list" className="mt-5 divide-y divide-chalk border-y border-chalk">
        {entries.map((entry) => (
          <li key={entry.reviewRecordId} className="flex flex-wrap items-center justify-between gap-3 py-3">
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-sm font-medium text-graphite">{formatReviewDate(entry.reviewDate)}</span>
              {showTypeLabel ? (
                <span className="border border-grit bg-chalk px-2 py-0.5 text-xs font-medium text-stone">
                  {entry.reviewEntityTypeName}
                </span>
              ) : null}
              {entry.resultLabel ? (
                <ChoicePill option={{ label: entry.resultLabel, color: entry.resultColor ?? undefined }} />
              ) : null}
              {entry.reviewerPersonRecordId && entry.reviewerLabel ? (
                <Link
                  href={`/entities/${personEntityTypeId}/records/${entry.reviewerPersonRecordId}`}
                  className="text-sm text-stone underline-offset-4 hover:underline"
                >
                  {entry.reviewerLabel}
                </Link>
              ) : (
                <span className="text-sm text-stone">Reviewer unavailable</span>
              )}
            </div>
            <Link
              href={`/entities/${entry.reviewEntityTypeId}/records/${entry.reviewRecordId}`}
              className="text-sm font-medium text-stone underline-offset-4 hover:underline"
            >
              View review
            </Link>
          </li>
        ))}
      </ul>
    </CollapsibleSection>
  );
}
