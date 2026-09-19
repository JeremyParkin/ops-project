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
  canManageSettings: boolean;
  canManageIntegrations: boolean;
  canViewAdministrativeHistory: boolean;
  quickJumpEntityTypes: QuickJumpEntityType[];
  hasMoreEntityTypes: boolean;
  unreadNotificationCount: number;
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
  canManageSettings,
  canManageIntegrations,
  canViewAdministrativeHistory,
  quickJumpEntityTypes,
  hasMoreEntityTypes,
  unreadNotificationCount,
  switchActiveWorkspaceAction,
  signOutAction,
}: AppHeaderProps) {
  const pathname = usePathname();
  const isNotifications = pathname.startsWith("/notifications");
  // Configure holds Automations/Processes/Data model/Workspace settings/
  // Workspace Health, each independently gated on its own capability. "Data
  // model" reuses the same /entities (All Objects) surface Business links
  // to -- Configure is simply a second, schema-minded entry point into it,
  // not a separate management system. Because canConfigure exactly unions
  // the same capabilities that gate the individual items below, no
  // combination ever produces an empty dropdown.
  const canConfigure =
    canManageWorkspace || canManageAutomation || canManageSchema || canManageSettings || canManageIntegrations || canViewAdministrativeHistory;
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
      <div className="mx-auto flex w-full max-w-[1600px] flex-nowrap items-center gap-1.5 px-4 py-2 sm:gap-2 sm:px-8 lg:px-10">
        <Link href="/" aria-label="Kinema home" className="mr-2 shrink-0">
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
              {canManageSettings ? (
                <MenuLink href="/settings/health">Workspace Health</MenuLink>
              ) : null}
              {canManageIntegrations ? (
                <MenuLink href="/settings/integrations">Integrations</MenuLink>
              ) : null}
              {canViewAdministrativeHistory ? <MenuLink href="/settings/history">History</MenuLink> : null}
            </NavMenu>
          ) : null}
        </nav>

        {/* Narrow-window fallback: everything above collapses into one menu
            rather than wrapping or overflowing the header row. */}
        <div className="shrink-0 lg:hidden">
          <NavMenu
            key={`mobile-${pathname}`}
            label={
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                className="h-5 w-5"
                aria-hidden="true"
              >
                <path d="M3 6h18M3 12h18M3 18h18" />
              </svg>
            }
            triggerAriaLabel="Menu"
            showCaret={false}
            align="right"
          >
            <MenuLink href="/">Home</MenuLink>
            <MenuLink href="/my-work">My Work</MenuLink>
            {canViewManagerPortfolio ? <MenuLink href="/team-work">Team Work</MenuLink> : null}
            <MenuLink href="/notifications">
              Notifications{unreadNotificationCount > 0 ? ` (${unreadNotificationCount})` : ""}
            </MenuLink>
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
                {canViewAdministrativeHistory ? <MenuLink href="/settings/history">History</MenuLink> : null}
              </>
            ) : null}
          </NavMenu>
        </div>

        <form
          action="/search"
          method="get"
          className="flex min-w-[5rem] flex-1 items-center lg:ml-4 lg:max-w-56 lg:flex-none"
        >
          <label className="sr-only" htmlFor="header-record-search">
            Search
          </label>
          <input
            id="header-record-search"
            name="q"
            type="search"
            className="h-9 w-full min-w-0 border border-slab bg-paper px-2 text-sm text-graphite placeholder:text-stone"
            placeholder="Search"
          />
        </form>

        <Link
          href="/notifications"
          aria-label={
            unreadNotificationCount > 0
              ? `Notifications, ${unreadNotificationCount} unread`
              : "Notifications"
          }
          className={`relative ml-auto flex shrink-0 items-center px-2 py-2 text-sm font-medium sm:px-3 ${
            isNotifications ? "bg-brass text-graphite" : "text-grit-light hover:bg-slab hover:text-chalk"
          }`}
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="h-5 w-5"
            aria-hidden="true"
          >
            <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
            <path d="M13.73 21a2 2 0 0 1-3.46 0" />
          </svg>
          {unreadNotificationCount > 0 ? (
            <span
              aria-hidden="true"
              className="ml-1.5 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-brass px-1 text-xs font-semibold text-graphite"
            >
              {unreadNotificationCount > 99 ? "99+" : unreadNotificationCount}
            </span>
          ) : null}
        </Link>

        <div className="shrink-0">
          <NavMenu
            key={`account-${pathname}`}
            label={
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="h-5 w-5"
                aria-hidden="true"
              >
                <circle cx="12" cy="8" r="4" />
                <path d="M4 20c0-4 3.5-6 8-6s8 2 8 6" />
              </svg>
            }
            triggerAriaLabel={`${workspaceName || "Account"}, account menu`}
            showCaret={false}
            align="right"
            triggerClassName="flex items-center px-2 py-2 text-sm font-medium text-grit-light hover:bg-slab hover:text-chalk sm:px-3"
          >
            {/* Workspace/environment name is not headline navigation
                context -- it lives here, inside the menu, rather than as
                persistent header text (dogfood direction after ab6629c). */}
            <div className="px-4 py-2">
              <div className="text-sm font-medium text-chalk">{workspaceName || "Account"}</div>
              <div className="mt-0.5 text-xs text-grit-light">{userEmail}</div>
            </div>
            <MenuDivider />
            {memberships.length > 1 ? (
              <>
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
                <MenuDivider />
              </>
            ) : null}
            <MenuLink href="/settings/personal">Personal settings</MenuLink>
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
