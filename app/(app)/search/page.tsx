import Link from "next/link";
import { PageHeader, WorkspacePageLayout } from "@/app/components/page-primitives";
import { searchWorkspaceRecords } from "@/lib/domain/record-repository";
import { getActiveWorkspaceId } from "@/lib/auth/workspace";

export const dynamic = "force-dynamic";

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const { q = "" } = await searchParams;
  const query = q.trim();
  const { workspaceId } = await getActiveWorkspaceId();
  const groups = await searchWorkspaceRecords({ workspaceId, query });

  return (
    <WorkspacePageLayout>
          <PageHeader
            eyebrow="Workspace"
            title="Search"
            description={
              query
                ? `${groups.reduce((count, group) => count + group.results.length, 0)} result${groups.reduce((count, group) => count + group.results.length, 0) === 1 ? "" : "s"} for “${query}”`
                : "Find what you're looking for across your workspace."
            }
          />
        <section className="mx-auto w-full max-w-6xl border border-slate-200 bg-white p-5">
          <header className="border-b border-slate-200 pb-5">
            <form action="/search" method="get" className="mt-4 flex max-w-xl gap-2">
              <label className="sr-only" htmlFor="search-query">
                Search
              </label>
              <input
                id="search-query"
                name="q"
                type="search"
                defaultValue={query}
                className="min-w-0 flex-1 border border-slate-300 bg-white px-3 py-2 text-slate-950"
                placeholder="Search your workspace"
              />
              <button
                type="submit"
                className="border border-brass bg-brass px-3 py-2 font-medium text-graphite hover:bg-brass-deep hover:text-paper"
              >
                Search
              </button>
            </form>
          </header>

          {!query ? (
            <div className="py-8 text-center">
              <p className="text-sm text-slate-600">Enter a search term to get started.</p>
            </div>
          ) : groups.length === 0 ? (
            <div className="py-8 text-center">
              <h2 className="text-lg font-semibold text-slate-950">No matches</h2>
              <p className="mt-2 text-sm text-slate-600">
                Nothing matches “{query}”. Try a different name or text value.
              </p>
            </div>
          ) : (
            <div className="space-y-8">
              {groups.map((group) => (
                <section key={group.entityType.id}>
                  <h2 className="text-lg font-semibold text-slate-950">
                    {group.entityType.name}{" "}
                    <span aria-hidden="true" className="text-sm font-normal text-slate-500">
                      ({group.results.length})
                    </span>
                  </h2>
                  <ul className="mt-3 divide-y divide-slate-200 border-y border-slate-200">
                    {group.results.map((result) => (
                      <li key={result.record.id} className="py-3">
                        <Link
                          href={`/entities/${group.entityType.id}/records/${result.record.id}`}
                          className="font-medium text-slate-950 underline-offset-4 hover:underline"
                        >
                          {result.label}
                        </Link>
                        {result.matchedFieldName ? (
                          <p className="mt-1 text-sm text-slate-500">
                            Matched in {result.matchedFieldName}
                          </p>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          )}
        </section>
    </WorkspacePageLayout>
  );
}
