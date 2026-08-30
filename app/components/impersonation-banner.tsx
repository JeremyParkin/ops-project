// A deliberately unmistakable color no other surface in the app uses --
// this must never be confused with an ordinary status/notice banner.
export function ImpersonationBanner({
  effectiveEmail,
  realActorEmail,
  endImpersonationAction,
}: {
  effectiveEmail: string;
  realActorEmail: string;
  endImpersonationAction: () => void | Promise<void>;
}) {
  return (
    <div className="flex flex-wrap items-center justify-center gap-2 bg-amber-500 px-4 py-2 text-center text-sm font-semibold text-graphite">
      <span>
        Viewing as <strong>{effectiveEmail}</strong> -- signed in as {realActorEmail}
      </span>
      <form action={endImpersonationAction}>
        <button
          type="submit"
          className="ml-2 h-7 border border-graphite bg-paper px-3 text-xs font-semibold text-graphite hover:bg-slab"
        >
          Exit impersonation
        </button>
      </form>
    </div>
  );
}
