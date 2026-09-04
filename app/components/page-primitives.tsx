import type { ReactNode } from "react";

type WorkspacePageLayoutProps = {
  contextNav?: ReactNode;
  children: ReactNode;
};

type PageHeaderProps = {
  eyebrow?: string;
  title: string;
  description?: string;
  actions?: ReactNode;
};

type SectionHeaderProps = {
  title: string;
  description?: string;
  actions?: ReactNode;
};

export function WorkspacePageLayout({
  contextNav,
  children,
}: WorkspacePageLayoutProps) {
  return (
    <main className="flex flex-1 flex-col gap-6 bg-background px-4 py-5 text-foreground sm:px-8 sm:py-7 lg:flex-row lg:px-10">
      {contextNav}
      <div className="flex min-w-0 flex-1 flex-col gap-6">{children}</div>
    </main>
  );
}

export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
}: PageHeaderProps) {
  return (
    <header className="mx-auto flex w-full max-w-6xl flex-wrap items-start justify-between gap-4 border-b border-grit pb-5">
      <div>
        {eyebrow ? (
          <p className="text-xs font-semibold uppercase tracking-wide text-stone">
            {eyebrow}
          </p>
        ) : null}
        <h1 className={`${eyebrow ? "mt-2" : ""} text-3xl font-semibold text-graphite`}>
          {title}
        </h1>
        {description ? (
          <p className="mt-2 max-w-2xl text-sm leading-6 text-stone">
            {description}
          </p>
        ) : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  );
}

export function SectionHeader({ title, description, actions }: SectionHeaderProps) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h2 className="text-lg font-semibold text-graphite">{title}</h2>
        {description ? <p className="mt-1 text-sm text-stone">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

type CollapsibleSectionProps = {
  title: string;
  description?: string;
  defaultOpen?: boolean;
  children: ReactNode;
};

// Native <details>/<summary> -- no React accordion state, no client-only
// dependency, so this works identically inside a Server Component (record
// detail's own top-level composition is one). No `actions` slot: nested
// interactive controls inside a native <summary> behave unreliably across
// browsers, and nothing today needs one -- deferred, not solved here.
export function CollapsibleSection({
  title,
  description,
  defaultOpen = true,
  children,
}: CollapsibleSectionProps) {
  return (
    <details className="group border border-grit bg-white" open={defaultOpen}>
      <summary className="flex cursor-pointer list-none items-start justify-between gap-3 p-5 [&::-webkit-details-marker]:hidden">
        <div>
          <h2 className="text-lg font-semibold text-graphite">{title}</h2>
          {description ? <p className="mt-1 text-sm text-stone">{description}</p> : null}
        </div>
        <span
          aria-hidden="true"
          className="mt-1 shrink-0 text-sm text-stone transition-transform group-open:rotate-90"
        >
          ▸
        </span>
      </summary>
      <div className="px-5 pb-5">{children}</div>
    </details>
  );
}
