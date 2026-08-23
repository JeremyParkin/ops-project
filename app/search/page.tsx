import Link from "next/link";
import { WorkspaceNavigation } from "@/app/components/entity-navigation";
import { searchWorkspaceRecords } from "@/lib/domain/record-repository";
import { listEntityTypes } from "@/lib/domain/metadata-repository";
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
  const [entityTypes, groups] = await Promise.all([
    listEntityTypes({ workspaceId }),
    searchWorkspaceRecords({ workspaceId, query }),
  ]);

  return (
    <main className="mx-auto flex min-h-screen max-w-7xl gap-6 p-6">
      <WorkspaceNavigation entityTypes={entityTypes} />
      <div className="min-w-0 flex-1">
        <section className="mx-auto w-full max-w-6xl border border-slate-200 bg-white p-5">
          <header className="mb-6 border-b border-slate-200 pb-6">
            <h1 className="text-2xl font-semibold text-slate-950">Search records</h1>
            <form action="/search" method="get" className="mt-4 flex max-w-xl gap-2">
              <label className="sr-only" htmlFor="search-query">
                Search records
              </label>
              <input
                id="search-query"
                name="q"
                type="search"
                defaultValue={query}
                className="min-w-0 flex-1 border border-slate-300 bg-white px-3 py-2 text-slate-950"
                placeholder="Search active records"
              />
              <button
                type="submit"
                className="border border-slate-950 bg-slate-950 px-3 py-2 font-medium text-white hover:bg-slate-800"
              >
                Search
              </button>
            </form>
          </header>

          {!query ? (
            <p className="text-slate-600">Enter a search term to find active records.</p>
          ) : groups.length === 0 ? (
            <p className="text-slate-600">No active records match “{query}”.</p>
          ) : (
            <div className="space-y-8">
              {groups.map((group) => (
                <section key={group.entityType.id}>
                  <h2 className="text-lg font-semibold text-slate-950">
                    {group.entityType.name}
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
      </div>
    </main>
  );
}
