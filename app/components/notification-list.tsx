"use client";

import Link from "next/link";
import { useActionState, useSyncExternalStore } from "react";
import {
  markAllNotificationsReadAction,
  markNotificationReadAction,
  type NotificationActionState,
} from "@/app/notification-actions";
import type { WorkspaceNotification } from "@/lib/domain/notification-types";

function formatTimestamp(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function NotificationTimestamp({ value }: { value: string }) {
  // No user timezone on the server -- delay local formatting until
  // hydration, matching ProcessDueAt's established pattern.
  const isHydrated = useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  );

  return <time dateTime={value}>{isHydrated ? formatTimestamp(value) : ""}</time>;
}

const initialState: NotificationActionState = { success: true, message: "" };

function MarkReadButton({
  notification,
  action,
}: {
  notification: WorkspaceNotification;
  action: (state: NotificationActionState, formData: FormData) => Promise<NotificationActionState>;
}) {
  const [, formAction, pending] = useActionState(action, initialState);

  if (notification.readAt) {
    return null;
  }

  return (
    <form action={formAction}>
      <input type="hidden" name="notificationId" value={notification.id} />
      <button
        type="submit"
        disabled={pending}
        className="text-xs font-medium text-graphite underline-offset-4 hover:underline disabled:cursor-not-allowed disabled:text-stone"
      >
        Mark read
      </button>
    </form>
  );
}

export function NotificationList({
  workspaceId,
  notifications,
}: {
  workspaceId: string;
  notifications: WorkspaceNotification[];
}) {
  const markOneReadAction = markNotificationReadAction.bind(null, { workspaceId });
  const [markAllState, markAllFormAction, markAllPending] = useActionState(
    markAllNotificationsReadAction.bind(null, { workspaceId }),
    initialState,
  );
  const unreadCount = notifications.filter((n) => !n.readAt).length;

  if (notifications.length === 0) {
    return (
      <section className="mx-auto w-full max-w-3xl border border-grit bg-white p-6">
        <p className="text-sm text-stone">You&apos;re all caught up. Nothing here yet.</p>
      </section>
    );
  }

  return (
    <section className="mx-auto w-full max-w-3xl border border-grit bg-white p-5">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-stone">
          {unreadCount > 0 ? `${unreadCount} unread` : "All caught up"}
        </p>
        {unreadCount > 0 ? (
          <form action={markAllFormAction}>
            <button
              type="submit"
              disabled={markAllPending}
              className="h-8 border border-grit px-3 text-xs font-medium text-stone hover:bg-slab/5 disabled:cursor-not-allowed"
            >
              {markAllPending ? "Marking..." : "Mark all read"}
            </button>
          </form>
        ) : null}
      </div>
      {markAllState.message ? (
        <p className="mt-2 text-xs text-red-700" role="alert">
          {markAllState.message}
        </p>
      ) : null}

      <ul className="mt-4 divide-y divide-chalk">
        {notifications.map((notification) => {
          const contextLine = [notification.context?.processTemplateName, notification.context?.originLabel]
            .filter(Boolean)
            .join(" · ");

          return (
            <li
              key={notification.id}
              className={`flex flex-wrap items-start justify-between gap-3 py-3 ${
                notification.readAt ? "" : "bg-brass/5"
              }`}
            >
              <Link
                href={notification.destinationHref}
                className="min-w-0 flex-1 text-sm text-graphite hover:underline"
              >
                <span className="font-medium">{notification.title}</span>
                {contextLine ? <span className="block text-stone">{contextLine}</span> : null}
                <span className="mt-0.5 block text-xs text-stone">
                  <NotificationTimestamp value={notification.createdAt} />
                </span>
              </Link>
              <MarkReadButton notification={notification} action={markOneReadAction} />
            </li>
          );
        })}
      </ul>
    </section>
  );
}
