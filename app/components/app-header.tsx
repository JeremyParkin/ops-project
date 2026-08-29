"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { NavMenu } from "@/app/components/nav-menu";

type QuickJumpEntityType = {
  id: string;
  name: string;
};

type AppHeaderProps = {
  workspaceName: string;
  memberships: { workspaceId: string; workspaceName: string }[];
  activeWorkspaceId: string;
  userEmail: string;
  canViewManagerPortfolio: boolean;
  canManageWorkspace: boolean;
  canManageAutomation: boolean;
  canManageSchema: boolean;
  quickJumpEntityTypes: QuickJumpEntityType[];
  hasMoreEntityTypes: boolean;
  switchActiveWorkspaceAction: (formData: FormData) => void | Promise<void>;
  signOutAction: () => void | Promise<void>;
};

function topLinkClass(active: boolean) {
  return `px-3 py-2 text-sm font-medium ${
    active ? "bg-brass text-graphite" : "text-grit-light hover:bg-slab hover:text-chalk"
  }`;
}

function MenuLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link
      href={href}
      className="block px-4 py-2 text-sm text-grit-light hover:bg-slab hover:text-chalk"
    >
      {children}
    </Link>
  );
}

function MenuLabel({ children }: { children: ReactNode }) {
  return (
    <div className="px-4 py-1.5 text-xs font-semibold uppercase tracking-wide text-stone">
      {children}
    </div>
  );
}

function MenuDivider() {
  return <div className="my-1 border-t border-slab" />;
}

export function AppHeader({
  workspaceName,
  memberships,
  activeWorkspaceId,
  userEmail,
  canViewManagerPortfolio,
  canManageWorkspace,
  canManageAutomation,
  canManageSchema,
  quickJumpEntityTypes,
  hasMoreEntityTypes,
  switchActiveWorkspaceAction,
  signOutAction,
}: AppHeaderProps) {
  const pathname = usePathname();
  // Configure holds Automations/Processes/Data model/Workspace settings, each
  // independently gated on its own capability. "Data model" reuses the same
  // /entities (All Objects) surface Business links to -- Configure is simply
  // a second, schema-minded entry point into it, not a separate management
  // system. Because canConfigure exactly unions the same three capabilities
  // that gate the individual items below, no combination ever produces an
  // empty dropdown: schema.manage alone shows Data model, automation.manage
  // alone shows Automations+Processes, etc.
  const canConfigure = canManageWorkspace || canManageAutomation || canManageSchema;
  const isHome = pathname === "/";
  const isWork = pathname.startsWith("/my-work") || pathname.startsWith("/team-work");
  const isBusiness = pathname.startsWith("/entities");
  const isAnalytics = pathname.startsWith("/analytics");
  const isConfigure =
    pathname.startsWith("/workflows") ||
    pathname.startsWith("/processes") ||
    pathname.startsWith("/process-runs") ||
    pathname.startsWith("/settings");

  return (
    <header className="bg-graphite">
      <div className="mx-auto flex w-full max-w-[1600px] flex-wrap items-center gap-2 px-4 py-2 sm:px-8 lg:flex-nowrap lg:px-10">
        <Link href="/" className="mr-2 shrink-0">
          <img
            src="/branding/kinema-L1-white-text.svg"
            alt="Kinema"
            className="h-7 w-auto"
          />
        </Link>

        <nav
          className="hidden flex-wrap items-center gap-1 lg:flex"
          aria-label="Primary navigation"
        >
          <Link href="/" className={topLinkClass(isHome)}>
            Home
          </Link>

          {canViewManagerPortfolio ? (
            <NavMenu key={`work-${pathname}`} label="Work" active={isWork}>
              <MenuLink href="/my-work">My Work</MenuLink>
              <MenuLink href="/team-work">Team Work</MenuLink>
            </NavMenu>
          ) : (
            <Link href="/my-work" className={topLinkClass(isWork)}>
              My Work
            </Link>
          )}

          <NavMenu key={`business-${pathname}`} label="Business" active={isBusiness}>
            <MenuLabel>Business objects</MenuLabel>
            {quickJumpEntityTypes.length === 0 ? (
              <p className="px-4 py-2 text-sm text-grit-light">
                No active business objects yet.
              </p>
            ) : (
              quickJumpEntityTypes.map((entityType) => (
                <MenuLink key={entityType.id} href={`/entities/${entityType.id}`}>
                  {entityType.name}
                </MenuLink>
              ))
            )}
            <MenuDivider />
            <MenuLink href="/entities">
              All objects{hasMoreEntityTypes ? " →" : ""}
            </MenuLink>
          </NavMenu>

          {canViewManagerPortfolio ? (
            <Link href="/analytics" className={topLinkClass(isAnalytics)}>
              Analytics
            </Link>
          ) : null}

          {canConfigure ? (
            <NavMenu key={`configure-${pathname}`} label="Configure" active={isConfigure}>
              {canManageAutomation ? <MenuLink href="/workflows">Automations</MenuLink> : null}
              {canManageAutomation ? <MenuLink href="/processes">Processes</MenuLink> : null}
              {canManageSchema ? <MenuLink href="/entities?manage=true">Data model</MenuLink> : null}
              {canManageWorkspace ? (
                <MenuLink href="/settings">Workspace settings</MenuLink>
              ) : null}
            </NavMenu>
          ) : null}
        </nav>

        {/* Narrow-window fallback: everything above collapses into one menu
            rather than wrapping or overflowing the header row. */}
        <div className="lg:hidden">
          <NavMenu key={`mobile-${pathname}`} label="Menu" showCaret={false} align="right">
            <MenuLink href="/">Home</MenuLink>
            <MenuLink href="/my-work">My Work</MenuLink>
            {canViewManagerPortfolio ? <MenuLink href="/team-work">Team Work</MenuLink> : null}
            <MenuDivider />
            <MenuLabel>Business objects</MenuLabel>
            {quickJumpEntityTypes.map((entityType) => (
              <MenuLink key={entityType.id} href={`/entities/${entityType.id}`}>
                {entityType.name}
              </MenuLink>
            ))}
            <MenuLink href="/entities">All objects</MenuLink>
            {canViewManagerPortfolio ? (
              <>
                <MenuDivider />
                <MenuLink href="/analytics">Analytics</MenuLink>
              </>
            ) : null}
            {canConfigure ? (
              <>
                <MenuDivider />
                <MenuLabel>Configure</MenuLabel>
                {canManageAutomation ? <MenuLink href="/workflows">Automations</MenuLink> : null}
                {canManageAutomation ? <MenuLink href="/processes">Processes</MenuLink> : null}
                {canManageSchema ? <MenuLink href="/entities?manage=true">Data model</MenuLink> : null}
                {canManageWorkspace ? (
                  <MenuLink href="/settings">Workspace settings</MenuLink>
                ) : null}
              </>
            ) : null}
          </NavMenu>
        </div>

        <form
          action="/search"
          method="get"
          className="order-last flex w-full min-w-0 items-center gap-2 pt-2 lg:order-none lg:ml-4 lg:w-56 lg:pt-0"
        >
          <label className="sr-only" htmlFor="header-record-search">
            Search
          </label>
          <input
            id="header-record-search"
            name="q"
            type="search"
            className="h-9 min-w-0 flex-1 border border-slab bg-paper px-2 text-sm text-graphite placeholder:text-stone"
            placeholder="Search"
          />
          <button
            type="submit"
            className="h-9 shrink-0 border border-slab px-3 text-sm font-medium text-grit-light hover:bg-slab hover:text-chalk"
          >
            Search
          </button>
        </form>

        <div className="ml-auto shrink-0">
          <NavMenu
            key={`account-${pathname}`}
            label={workspaceName || "Account"}
            triggerAriaLabel="Account menu"
            align="right"
            triggerClassName="flex items-center gap-1 px-3 py-2 text-sm font-medium text-grit-light hover:bg-slab hover:text-chalk"
          >
            <MenuLabel>{userEmail}</MenuLabel>
            {memberships.length > 1 ? (
              <>
                <MenuDivider />
                <MenuLabel>Switch workspace</MenuLabel>
                {memberships.map((membership) => (
                  <form key={membership.workspaceId} action={switchActiveWorkspaceAction}>
                    <input type="hidden" name="workspaceId" value={membership.workspaceId} />
                    <button
                      type="submit"
                      disabled={membership.workspaceId === activeWorkspaceId}
                      className="block w-full px-4 py-2 text-left text-sm text-grit-light hover:bg-slab hover:text-chalk disabled:cursor-default disabled:text-chalk disabled:hover:bg-transparent"
                    >
                      {membership.workspaceName}
                      {membership.workspaceId === activeWorkspaceId ? " (current)" : ""}
                    </button>
                  </form>
                ))}
              </>
            ) : null}
            <MenuDivider />
            <form action={signOutAction}>
              <button
                type="submit"
                className="block w-full px-4 py-2 text-left text-sm text-grit-light hover:bg-slab hover:text-chalk"
              >
                Sign out
              </button>
            </form>
          </NavMenu>
        </div>
      </div>
    </header>
  );
}
