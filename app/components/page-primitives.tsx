import type { ReactNode } from "react";

type WorkspacePageLayoutProps = {
  navigation: ReactNode;
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
  navigation,
  children,
}: WorkspacePageLayoutProps) {
  return (
    <main className="flex flex-1 flex-col gap-6 bg-background px-4 py-5 text-foreground sm:px-8 sm:py-7 lg:flex-row lg:px-10">
      {navigation}
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
