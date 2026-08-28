import Link from "next/link";
import { ProcessDueAt } from "@/app/components/process-due-at";
import type { MyWorkItem, MyWorkSummary } from "@/lib/domain/process-repository";

// Home's "what needs you" strip: the same My Work data, trimmed to at most
// three items so Home stays a landing point, not a second My Work page.
export function HomeAttentionSummary({ summary }: { summary: MyWorkSummary }) {
  const topItems: MyWorkItem[] = [...summary.overdue, ...summary.readyNow].slice(0, 3);
  const totalActive = summary.overdue.length + summary.readyNow.length;

  return (
    <section className="mx-auto w-full max-w-6xl border border-grit bg-white p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-lg font-semibold text-graphite">What needs you</h2>
        {totalActive > 0 ? (
          <Link
            href="/my-work"
            className="text-sm font-medium text-stone underline-offset-4 hover:text-graphite hover:underline"
          >
            View My Work
          </Link>
        ) : null}
      </div>

      {totalActive === 0 ? (
        <p className="mt-3 text-sm text-stone">
          You&apos;re all caught up. Nothing needs your attention right now.
        </p>
      ) : (
        <>
          <p className="mt-1 text-sm text-stone">
            {summary.overdue.length > 0
              ? `${summary.overdue.length} overdue, ${summary.readyNow.length} ready now.`
              : `${summary.readyNow.length} ready now.`}
          </p>
          <ul className="mt-4 flex flex-col gap-3">
            {topItems.map((item) => (
              <li key={item.stepRun.id} className="border border-grit p-3">
                <p className="text-sm font-semibold text-graphite">{item.stepRun.name}</p>
                <p className="mt-1 text-sm text-stone">
                  {item.run.processTemplateName} ·{" "}
                  <Link href={item.originHref} className="underline-offset-4 hover:underline">
                    {item.originRecordLabel}
                  </Link>
                </p>
                {item.stepRun.dueAt ? (
                  <p className="mt-1 text-xs font-medium text-stone">
                    <ProcessDueAt dueAt={item.stepRun.dueAt} />
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
