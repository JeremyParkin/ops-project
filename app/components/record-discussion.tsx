"use client";

import { useActionState, useEffect, useRef, useSyncExternalStore } from "react";
import {
  type RecordCommentActionState,
} from "@/app/actions";
import { SectionHeader } from "@/app/components/page-primitives";
import type { RecordComment } from "@/lib/domain/record-comment-repository";
import { RECORD_COMMENT_BODY_MAX_LENGTH } from "@/lib/domain/record-comment-validation";

type CommentAction = (
  state: RecordCommentActionState,
  formData: FormData,
) => Promise<RecordCommentActionState>;

type RecordDiscussionProps = {
  comments: RecordComment[];
  isArchivedRecord: boolean;
  createCommentAction: CommentAction;
  tombstoneCommentAction: CommentAction;
};

const initialCommentState: RecordCommentActionState = {
  success: false,
  message: "",
  body: "",
};

function formatTimestamp(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function LocalTimestamp({ value }: { value: string }) {
  const isHydrated = useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  );

  return <time dateTime={value}>{isHydrated ? formatTimestamp(value) : ""}</time>;
}

function actorLine(label: string, realActorLabel?: string) {
  return realActorLabel ? `${label} via ${realActorLabel}` : label;
}

function CommentComposer({
  action,
  isArchivedRecord,
}: {
  action: CommentAction;
  isArchivedRecord: boolean;
}) {
  const [state, formAction, pending] = useActionState(action, initialCommentState);
  const formRef = useRef<HTMLFormElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (state.success) {
      formRef.current?.reset();
    }
  }, [state.success]);

  if (isArchivedRecord) {
    return (
      <p className="mt-4 border border-grit bg-chalk px-3 py-2 text-sm text-stone">
        Archived records are read-only. Existing discussion remains available.
      </p>
    );
  }

  return (
    <form ref={formRef} action={formAction} className="mt-4 grid gap-3">
      <label htmlFor="record-comment-body" className="sr-only">
        Add a comment
      </label>
      <textarea
        ref={textareaRef}
        id="record-comment-body"
        name="body"
        rows={4}
        maxLength={RECORD_COMMENT_BODY_MAX_LENGTH}
        defaultValue={state.body}
        aria-invalid={state.message && !state.success ? "true" : "false"}
        className="w-full resize-y border border-grit px-3 py-2 text-sm text-graphite outline-none focus:border-graphite"
      />
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="inline-flex h-9 items-center justify-center bg-brass px-3 text-sm font-medium text-graphite hover:bg-brass-deep hover:text-paper disabled:cursor-not-allowed disabled:bg-chalk disabled:text-stone"
        >
          {pending ? "Adding..." : "Add comment"}
        </button>
        {state.message ? (
          <p
            className={state.success ? "text-sm text-status-sage" : "text-sm text-red-700"}
            role={state.success ? "status" : "alert"}
          >
            {state.message}
          </p>
        ) : null}
      </div>
    </form>
  );
}

function TombstoneCommentForm({
  action,
  commentId,
}: {
  action: CommentAction;
  commentId: string;
}) {
  const [state, formAction, pending] = useActionState(action, initialCommentState);

  return (
    <form action={formAction}>
      <input type="hidden" name="commentId" value={commentId} />
      <button
        type="submit"
        disabled={pending}
        className="text-xs font-medium text-stone underline-offset-4 hover:text-graphite hover:underline disabled:cursor-not-allowed disabled:text-grit"
      >
        {pending ? "Removing..." : "Remove"}
      </button>
      {state.message && !state.success ? (
        <p className="mt-1 text-xs text-red-700" role="alert">
          {state.message}
        </p>
      ) : null}
    </form>
  );
}

export function RecordDiscussion({
  comments,
  isArchivedRecord,
  createCommentAction,
  tombstoneCommentAction,
}: RecordDiscussionProps) {
  return (
    <section className="border border-grit bg-white p-5">
      <SectionHeader title="Discussion" />

      {comments.length === 0 ? (
        <p className="mt-4 text-sm text-stone">No comments yet.</p>
      ) : (
        <ul className="mt-4 divide-y divide-chalk">
          {comments.map((comment) => {
            const isRemoved = Boolean(comment.tombstonedAt);

            return (
              <li key={comment.id} className="py-3">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-graphite">
                      {actorLine(comment.authorLabel, comment.realActorLabel)}
                    </p>
                    <p className="mt-0.5 text-xs text-stone">
                      <LocalTimestamp value={comment.createdAt} />
                    </p>
                  </div>
                  {!isRemoved ? (
                    <TombstoneCommentForm
                      action={tombstoneCommentAction}
                      commentId={comment.id}
                    />
                  ) : null}
                </div>
                {isRemoved ? (
                  <p className="mt-2 border border-dashed border-grit bg-chalk px-3 py-2 text-sm text-stone">
                    Comment removed
                    {comment.tombstonedAt ? (
                      <span className="block text-xs">
                        <LocalTimestamp value={comment.tombstonedAt} />
                        {comment.tombstonedByLabel
                          ? ` by ${actorLine(
                              comment.tombstonedByLabel,
                              comment.tombstonedByRealActorLabel,
                            )}`
                          : ""}
                      </span>
                    ) : null}
                  </p>
                ) : (
                  <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-graphite">
                    {comment.body ?? ""}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <CommentComposer
        action={createCommentAction}
        isArchivedRecord={isArchivedRecord}
      />
    </section>
  );
}
