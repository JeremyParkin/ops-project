"use client";

import {
  Fragment,
  useActionState,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  type RecordCommentActionState,
} from "@/app/actions";
import { SectionHeader } from "@/app/components/page-primitives";
import type {
  RecordComment,
  RecordCommentMentionCandidate,
} from "@/lib/domain/record-comment-repository";
import { RECORD_COMMENT_BODY_MAX_LENGTH } from "@/lib/domain/record-comment-validation";

type CommentAction = (
  state: RecordCommentActionState,
  formData: FormData,
) => Promise<RecordCommentActionState>;

type RecordDiscussionProps = {
  comments: RecordComment[];
  mentionCandidates: RecordCommentMentionCandidate[];
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

function mentionText(candidate: RecordCommentMentionCandidate) {
  return `@${candidate.email}`;
}

function bodyIncludesMention(body: string, candidate: RecordCommentMentionCandidate) {
  return body.includes(mentionText(candidate));
}

function renderPlainTextWithMentions(body: string) {
  const parts = body.split(/(@[^\s@]+)/g);

  return parts.map((part, index) => {
    if (!part.startsWith("@") || part.length === 1) {
      return <Fragment key={`${part}-${index}`}>{part}</Fragment>;
    }

    return (
      <span
        key={`${part}-${index}`}
        className="font-medium text-graphite underline decoration-brass decoration-2 underline-offset-2"
      >
        {part}
      </span>
    );
  });
}

function CommentComposer({
  action,
  isArchivedRecord,
  mentionCandidates,
}: {
  action: CommentAction;
  isArchivedRecord: boolean;
  mentionCandidates: RecordCommentMentionCandidate[];
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const desiredCursorPositionRef = useRef<number | null>(null);
  const bodyValueRef = useRef(initialCommentState.body ?? "");
  const selectedMentionIdsRef = useRef<string[]>([]);
  const [body, setBody] = useState(initialCommentState.body ?? "");
  const [selectedMentionIds, setSelectedMentionIds] = useState<string[]>([]);
  const [cursorPosition, setCursorPosition] = useState(0);
  const [activeSuggestionIndex, setActiveSuggestionIndex] = useState(0);
  const [dismissedMentionQuery, setDismissedMentionQuery] = useState<string | null>(null);

  async function submitComment(
    previousState: RecordCommentActionState,
    formData: FormData,
  ): Promise<RecordCommentActionState> {
    const liveTextareaBody = textareaRef.current?.value;
    const submittedBody =
      typeof liveTextareaBody === "string" && liveTextareaBody !== bodyValueRef.current
        ? liveTextareaBody
        : bodyValueRef.current;
    formData.set("body", submittedBody);
    formData.delete("mentionedUserIds");
    selectedMentionIdsRef.current.forEach((id) => {
      const candidate = mentionCandidates.find((member) => member.userId === id);
      if (candidate && bodyIncludesMention(submittedBody, candidate)) {
        formData.append("mentionedUserIds", id);
      }
    });

    return action(previousState, formData);
  }

  const [state, formAction, pending] = useActionState(submitComment, initialCommentState);

  useLayoutEffect(() => {
    if (desiredCursorPositionRef.current === null) return;

    const nextCursorPosition = desiredCursorPositionRef.current;
    desiredCursorPositionRef.current = null;
    textareaRef.current?.focus();
    textareaRef.current?.setSelectionRange(nextCursorPosition, nextCursorPosition);
  }, [body]);

  const selectedMentionCandidates = useMemo(() => {
    const candidateById = new Map(mentionCandidates.map((candidate) => [candidate.userId, candidate]));
    return selectedMentionIds
      .map((id) => candidateById.get(id))
      .filter((candidate): candidate is RecordCommentMentionCandidate => Boolean(candidate));
  }, [mentionCandidates, selectedMentionIds]);

  const mentionQuery = useMemo(() => {
    const prefix = body.slice(0, cursorPosition);
    const match = /(^|\s)@([^\s@]*)$/.exec(prefix);
    if (!match) return null;

    return {
      query: match[2].toLowerCase(),
      start: prefix.length - match[2].length - 1,
      end: cursorPosition,
    };
  }, [body, cursorPosition]);

  const mentionSuggestions = useMemo(() => {
    if (!mentionQuery) return [];
    if (dismissedMentionQuery === `${mentionQuery.start}:${mentionQuery.query}`) return [];

    return mentionCandidates
      .filter((candidate) => candidate.email.toLowerCase().includes(mentionQuery.query))
      .slice(0, 6);
  }, [dismissedMentionQuery, mentionCandidates, mentionQuery]);

  function syncSelectedMentions(nextBody: string) {
    setSelectedMentionIds((ids) => {
      const nextIds = ids.filter((id) => {
        const candidate = mentionCandidates.find((member) => member.userId === id);
        return candidate ? bodyIncludesMention(nextBody, candidate) : false;
      });
      selectedMentionIdsRef.current = nextIds;
      return nextIds;
    });
  }

  function updateBody(nextBody: string, nextCursorPosition?: number) {
    bodyValueRef.current = nextBody;
    setBody(nextBody);
    setCursorPosition(nextCursorPosition ?? textareaRef.current?.selectionStart ?? nextBody.length);
    setActiveSuggestionIndex(0);
    setDismissedMentionQuery(null);
    syncSelectedMentions(nextBody);
  }

  function insertMention(candidate: RecordCommentMentionCandidate) {
    if (!mentionQuery) return;

    const inserted = `${mentionText(candidate)} `;
    const nextBody = `${body.slice(0, mentionQuery.start)}${inserted}${body.slice(mentionQuery.end)}`;
    const nextCursorPosition = mentionQuery.start + inserted.length;
    desiredCursorPositionRef.current = nextCursorPosition;
    bodyValueRef.current = nextBody;
    setBody(nextBody);
    setCursorPosition(nextCursorPosition);
    setDismissedMentionQuery(null);
    setSelectedMentionIds((ids) => {
      const nextIds = ids.includes(candidate.userId) ? ids : [...ids, candidate.userId];
      selectedMentionIdsRef.current = nextIds;
      return nextIds;
    });
  }

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
        value={body}
        aria-invalid={state.message && !state.success ? "true" : "false"}
        aria-autocomplete="list"
        aria-controls={mentionSuggestions.length > 0 ? "record-comment-mention-suggestions" : undefined}
        aria-activedescendant={
          mentionSuggestions.length > 0
            ? `record-comment-mention-suggestion-${mentionSuggestions[activeSuggestionIndex]?.userId}`
            : undefined
        }
        onChange={(event) => updateBody(event.currentTarget.value, event.currentTarget.selectionStart)}
        onSelect={(event) => setCursorPosition(event.currentTarget.selectionStart)}
        onKeyDown={(event) => {
          if (mentionSuggestions.length === 0) return;

          if (event.key === "ArrowDown") {
            event.preventDefault();
            setActiveSuggestionIndex((index) => (index + 1) % mentionSuggestions.length);
          } else if (event.key === "ArrowUp") {
            event.preventDefault();
            setActiveSuggestionIndex((index) => (index - 1 + mentionSuggestions.length) % mentionSuggestions.length);
          } else if (event.key === "Enter" || event.key === "Tab") {
            event.preventDefault();
            insertMention(mentionSuggestions[activeSuggestionIndex]);
          } else if (event.key === "Escape") {
            if (mentionQuery) {
              setDismissedMentionQuery(`${mentionQuery.start}:${mentionQuery.query}`);
            }
          }
        }}
        className="w-full resize-y border border-grit px-3 py-2 text-sm text-graphite outline-none focus:border-graphite"
      />
      {selectedMentionCandidates.map((candidate) => (
        <input key={candidate.userId} type="hidden" name="mentionedUserIds" value={candidate.userId} />
      ))}
      {mentionSuggestions.length > 0 ? (
        <div
          id="record-comment-mention-suggestions"
          role="listbox"
          className="max-h-48 overflow-auto border border-grit bg-white shadow-sm"
        >
          {mentionSuggestions.map((candidate, index) => (
            <button
              key={candidate.userId}
              id={`record-comment-mention-suggestion-${candidate.userId}`}
              type="button"
              role="option"
              aria-selected={index === activeSuggestionIndex}
              onMouseDown={(event) => {
                event.preventDefault();
                insertMention(candidate);
              }}
              className={`block w-full px-3 py-2 text-left text-sm ${
                index === activeSuggestionIndex
                  ? "bg-chalk text-graphite"
                  : "text-stone hover:bg-chalk hover:text-graphite"
              }`}
            >
              {mentionText(candidate)}
            </button>
          ))}
        </div>
      ) : null}
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
  mentionCandidates,
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
              <li key={comment.id} id={`comment-${comment.id}`} className="scroll-mt-24 py-3">
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
                    {renderPlainTextWithMentions(comment.body ?? "")}
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
        mentionCandidates={mentionCandidates}
      />
    </section>
  );
}
