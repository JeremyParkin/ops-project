"use client";

import {
  Fragment,
  useActionState,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { SectionHeader } from "@/app/components/page-primitives";
import { RECORD_COMMENT_BODY_MAX_LENGTH } from "@/lib/domain/record-comment-validation";

export type DiscussionActionState = {
  success: boolean;
  message: string;
  body?: string;
  resetKey?: string;
};

export type DiscussionComment = {
  id: string;
  body?: string;
  authorLabel: string;
  realActorLabel?: string;
  createdAt: string;
  tombstonedAt?: string;
  tombstonedByLabel?: string;
  tombstonedByRealActorLabel?: string;
};

export type DiscussionMentionCandidate = {
  userId: string;
  email: string;
};

export type DiscussionInputRequest = {
  id: string;
  originRecordCommentId: string;
  recipientUserId: string;
  recipientLabel: string;
  responseRecordCommentId?: string;
  cancelledAt?: string;
  originAuthorUserId: string;
  state: "open" | "responded" | "cancelled";
};

type DiscussionAction = (
  state: DiscussionActionState,
  formData: FormData,
) => Promise<DiscussionActionState>;

type DiscussionSectionProps = {
  title?: string;
  comments: DiscussionComment[];
  mentionCandidates: DiscussionMentionCandidate[];
  inputRequests?: DiscussionInputRequest[];
  inputRequestRecipientCandidates?: DiscussionMentionCandidate[];
  currentUserId?: string;
  canCancelAnyInputRequest?: boolean;
  composerUnavailableMessage?: string;
  hiddenFields?: Array<{ name: string; value: string }>;
  createCommentAction: DiscussionAction;
  tombstoneCommentAction: DiscussionAction;
  createInputRequestAction?: DiscussionAction;
  respondInputRequestAction?: DiscussionAction;
  cancelInputRequestAction?: DiscussionAction;
  commentAnchorPrefix?: string;
  inputIdPrefix: string;
};

const initialCommentState: DiscussionActionState = {
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

function mentionText(candidate: DiscussionMentionCandidate) {
  return `@${candidate.email}`;
}

function bodyIncludesMention(body: string, candidate: DiscussionMentionCandidate) {
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
  composerUnavailableMessage,
  hiddenFields = [],
  mentionCandidates,
  inputIdPrefix,
}: {
  action: DiscussionAction;
  composerUnavailableMessage?: string;
  hiddenFields?: Array<{ name: string; value: string }>;
  mentionCandidates: DiscussionMentionCandidate[];
  inputIdPrefix: string;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const desiredCursorPositionRef = useRef<number | null>(null);
  const bodyValueRef = useRef(initialCommentState.body ?? "");
  const lastSubmittedBodyRef = useRef<string | null>(null);
  const selectedMentionIdsRef = useRef<string[]>([]);
  const [body, setBody] = useState(initialCommentState.body ?? "");
  const [selectedMentionIds, setSelectedMentionIds] = useState<string[]>([]);
  const [cursorPosition, setCursorPosition] = useState(0);
  const [activeSuggestionIndex, setActiveSuggestionIndex] = useState(0);
  const [dismissedMentionQuery, setDismissedMentionQuery] = useState<string | null>(null);

  const [state, formAction, pending] = useActionState(action, initialCommentState);

  useEffect(() => {
    if (!state.success) return;
    const submittedBody = lastSubmittedBodyRef.current;
    if (submittedBody !== null && bodyValueRef.current !== submittedBody) return;

    bodyValueRef.current = "";
    selectedMentionIdsRef.current = [];
    setBody("");
    setSelectedMentionIds([]);
    setCursorPosition(0);
    setActiveSuggestionIndex(0);
    setDismissedMentionQuery(null);
  }, [state.success, state.resetKey]);

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
      .filter((candidate): candidate is DiscussionMentionCandidate => Boolean(candidate));
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

  function insertMention(candidate: DiscussionMentionCandidate) {
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

  if (composerUnavailableMessage) {
    return (
      <p className="mt-4 border border-grit bg-chalk px-3 py-2 text-sm text-stone">
        {composerUnavailableMessage}
      </p>
    );
  }

  return (
    <form
      ref={formRef}
      action={formAction}
      className="mt-4 grid gap-3"
      onSubmit={() => {
        lastSubmittedBodyRef.current = textareaRef.current?.value ?? bodyValueRef.current;
      }}
    >
      {hiddenFields.map((field) => (
        <input key={`${field.name}:${field.value}`} type="hidden" name={field.name} value={field.value} />
      ))}
      <label htmlFor={`${inputIdPrefix}-comment-body`} className="sr-only">
        Add a comment
      </label>
      <textarea
        ref={textareaRef}
        id={`${inputIdPrefix}-comment-body`}
        name="body"
        rows={4}
        maxLength={RECORD_COMMENT_BODY_MAX_LENGTH}
        value={body}
        aria-invalid={state.message && !state.success ? "true" : "false"}
        aria-autocomplete="list"
        aria-controls={mentionSuggestions.length > 0 ? `${inputIdPrefix}-comment-mention-suggestions` : undefined}
        aria-activedescendant={
          mentionSuggestions.length > 0
            ? `${inputIdPrefix}-comment-mention-suggestion-${mentionSuggestions[activeSuggestionIndex]?.userId}`
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
          id={`${inputIdPrefix}-comment-mention-suggestions`}
          role="listbox"
          className="max-h-48 overflow-auto border border-grit bg-white shadow-sm"
        >
          {mentionSuggestions.map((candidate, index) => (
            <button
              key={candidate.userId}
              id={`${inputIdPrefix}-comment-mention-suggestion-${candidate.userId}`}
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
  action: DiscussionAction;
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

function RequestInputForm({
  action,
  recipientCandidates,
  inputIdPrefix,
}: {
  action: DiscussionAction;
  recipientCandidates: DiscussionMentionCandidate[];
  inputIdPrefix: string;
}) {
  const [state, formAction, pending] = useActionState(action, initialCommentState);

  return (
    <details className="mt-4 border border-grit bg-chalk px-3 py-2">
      <summary className="cursor-pointer text-sm font-medium text-graphite">Request input</summary>
      <form key={state.resetKey ?? "request-input-form"} action={formAction} className="mt-3 grid gap-3">
        <label htmlFor={`${inputIdPrefix}-request-recipient`} className="sr-only">
          Recipient
        </label>
        <select
          id={`${inputIdPrefix}-request-recipient`}
          name="recipientUserId"
          className="h-9 border border-grit bg-white px-2 text-sm text-graphite"
          defaultValue=""
        >
          <option value="" disabled>
            Choose recipient
          </option>
          {recipientCandidates.map((candidate) => (
            <option key={candidate.userId} value={candidate.userId}>
              {candidate.email}
            </option>
          ))}
        </select>
        <label htmlFor={`${inputIdPrefix}-request-body`} className="sr-only">
          Request body
        </label>
        <textarea
          id={`${inputIdPrefix}-request-body`}
          name="body"
          rows={3}
          maxLength={RECORD_COMMENT_BODY_MAX_LENGTH}
          defaultValue={state.success ? "" : state.body ?? ""}
          className="w-full resize-y border border-grit bg-white px-3 py-2 text-sm text-graphite outline-none focus:border-graphite"
        />
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="submit"
            disabled={pending}
            className="inline-flex h-9 items-center justify-center bg-brass px-3 text-sm font-medium text-graphite hover:bg-brass-deep hover:text-paper disabled:cursor-not-allowed disabled:bg-chalk disabled:text-stone"
          >
            {pending ? "Sending..." : "Send request"}
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
    </details>
  );
}

function RespondInputRequestForm({
  action,
  requestId,
  inputIdPrefix,
}: {
  action: DiscussionAction;
  requestId: string;
  inputIdPrefix: string;
}) {
  const [state, formAction, pending] = useActionState(action, initialCommentState);

  return (
    <form key={state.resetKey ?? `respond-${requestId}`} action={formAction} className="mt-3 grid gap-2">
      <input type="hidden" name="requestId" value={requestId} />
      <label htmlFor={`${inputIdPrefix}-request-${requestId}-response`} className="sr-only">
        Response
      </label>
      <textarea
        id={`${inputIdPrefix}-request-${requestId}-response`}
        name="body"
        rows={3}
        maxLength={RECORD_COMMENT_BODY_MAX_LENGTH}
        defaultValue={state.success ? "" : state.body ?? ""}
        className="w-full resize-y border border-grit bg-white px-3 py-2 text-sm text-graphite outline-none focus:border-graphite"
      />
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="inline-flex h-8 items-center justify-center bg-graphite px-3 text-xs font-medium text-paper hover:bg-slate disabled:cursor-not-allowed disabled:bg-chalk disabled:text-stone"
        >
          {pending ? "Responding..." : "Respond"}
        </button>
        {state.message ? (
          <p
            className={state.success ? "text-xs text-status-sage" : "text-xs text-red-700"}
            role={state.success ? "status" : "alert"}
          >
            {state.message}
          </p>
        ) : null}
      </div>
    </form>
  );
}

function CancelInputRequestForm({
  action,
  requestId,
}: {
  action: DiscussionAction;
  requestId: string;
}) {
  const [state, formAction, pending] = useActionState(action, initialCommentState);

  return (
    <form action={formAction}>
      <input type="hidden" name="requestId" value={requestId} />
      <button
        type="submit"
        disabled={pending}
        className="text-xs font-medium text-stone underline-offset-4 hover:text-graphite hover:underline disabled:cursor-not-allowed disabled:text-grit"
      >
        {pending ? "Cancelling..." : "Cancel request"}
      </button>
      {state.message && !state.success ? (
        <p className="mt-1 text-xs text-red-700" role="alert">
          {state.message}
        </p>
      ) : null}
    </form>
  );
}

function InputRequestTreatment({
  request,
  currentUserId,
  canCancelAnyInputRequest,
  isArchived,
  respondAction,
  cancelAction,
  inputIdPrefix,
}: {
  request: DiscussionInputRequest;
  currentUserId?: string;
  canCancelAnyInputRequest?: boolean;
  isArchived: boolean;
  respondAction?: DiscussionAction;
  cancelAction?: DiscussionAction;
  inputIdPrefix: string;
}) {
  const canRespond = request.state === "open" && currentUserId === request.recipientUserId;
  const canCancel =
    request.state === "open" &&
    (currentUserId === request.originAuthorUserId || Boolean(canCancelAnyInputRequest));
  const statusCopy =
    request.state === "responded"
      ? "Responded"
      : request.state === "cancelled"
        ? "Cancelled"
        : "Open";

  return (
    <div
      id={`input-request-${request.id}`}
      className="mt-3 scroll-mt-24 border-l-4 border-brass bg-chalk px-3 py-2"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm font-medium text-graphite">
          Input requested from {request.recipientLabel}
          <span className="ml-2 text-xs font-medium uppercase text-stone">{statusCopy}</span>
        </p>
        {canCancel && cancelAction ? (
          <CancelInputRequestForm action={cancelAction} requestId={request.id} />
        ) : null}
      </div>
      {request.responseRecordCommentId ? (
        <a
          href={`#comment-${request.responseRecordCommentId}`}
          className="mt-1 inline-flex text-xs font-medium text-stone underline-offset-4 hover:text-graphite hover:underline"
        >
          View response
        </a>
      ) : null}
      {isArchived && request.state === "open" ? (
        <p className="mt-2 text-xs text-stone">
          Archived records can no longer receive responses.
        </p>
      ) : canRespond && respondAction ? (
        <RespondInputRequestForm
          action={respondAction}
          requestId={request.id}
          inputIdPrefix={inputIdPrefix}
        />
      ) : null}
    </div>
  );
}

export function DiscussionSection({
  title = "Discussion",
  comments,
  mentionCandidates,
  inputRequests = [],
  inputRequestRecipientCandidates = [],
  currentUserId,
  canCancelAnyInputRequest,
  composerUnavailableMessage,
  hiddenFields,
  createCommentAction,
  tombstoneCommentAction,
  createInputRequestAction,
  respondInputRequestAction,
  cancelInputRequestAction,
  commentAnchorPrefix = "comment",
  inputIdPrefix,
}: DiscussionSectionProps) {
  const inputRequestByOriginCommentId = new Map(
    inputRequests.map((request) => [request.originRecordCommentId, request]),
  );
  const responseRequestByCommentId = new Map(
    inputRequests
      .filter((request) => request.responseRecordCommentId)
      .map((request) => [request.responseRecordCommentId as string, request]),
  );

  return (
    <section className="border border-grit bg-white p-5">
      <SectionHeader title={title} />

      {comments.length === 0 ? (
        <p className="mt-4 text-sm text-stone">No comments yet.</p>
      ) : (
        <ul className="mt-4 divide-y divide-chalk">
          {comments.map((comment) => {
            const isRemoved = Boolean(comment.tombstonedAt);
            const inputRequest = inputRequestByOriginCommentId.get(comment.id);
            const responseRequest = responseRequestByCommentId.get(comment.id);

            return (
              <li key={comment.id} id={`${commentAnchorPrefix}-${comment.id}`} className="scroll-mt-24 py-3">
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
                {inputRequest ? (
                  <InputRequestTreatment
                    request={inputRequest}
                    currentUserId={currentUserId}
                    canCancelAnyInputRequest={canCancelAnyInputRequest}
                    isArchived={Boolean(composerUnavailableMessage)}
                    respondAction={respondInputRequestAction}
                    cancelAction={cancelInputRequestAction}
                    inputIdPrefix={inputIdPrefix}
                  />
                ) : null}
                {responseRequest ? (
                  <p className="mt-2 text-xs font-medium text-stone">
                    Response to input request
                  </p>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      {!composerUnavailableMessage && createInputRequestAction ? (
        <RequestInputForm
          action={createInputRequestAction}
          recipientCandidates={inputRequestRecipientCandidates}
          inputIdPrefix={inputIdPrefix}
        />
      ) : null}

      <CommentComposer
        action={createCommentAction}
        composerUnavailableMessage={composerUnavailableMessage}
        hiddenFields={hiddenFields}
        mentionCandidates={mentionCandidates}
        inputIdPrefix={inputIdPrefix}
      />
    </section>
  );
}
