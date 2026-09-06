import { createServerSupabaseClient, type SupabaseServerClient } from "@/lib/supabase/server";

export async function finalizeQualityReview({
  workspaceId,
  entityTypeId,
  recordId,
  supabase: injectedSupabase,
}: {
  workspaceId: string;
  entityTypeId: string;
  recordId: string;
  supabase?: SupabaseServerClient;
}): Promise<void> {
  const supabase = injectedSupabase ?? (await createServerSupabaseClient());
  const { error } = await supabase.rpc("finalize_quality_review_authorized", {
    p_workspace_id: workspaceId,
    p_entity_type_id: entityTypeId,
    p_record_id: recordId,
  });

  if (error) {
    throw new Error(error.message);
  }
}

export type QualityReviewRecordContext = {
  isQualityReviewType: boolean;
  isDraft: boolean;
  isFinalized: boolean;
  isReviewer: boolean;
};

type EntityTypeQualityReviewRow = {
  quality_review: boolean;
  quality_review_status_field_id: string | null;
  quality_review_draft_option_id: string | null;
  quality_review_finalized_option_id: string | null;
  author_person_field_id: string | null;
};

// Resolves everything the record-detail page needs to decide whether to
// show a Draft/Finalized badge and the Finalize/Reopen actions, and
// whether generic inline editing should even be offered. Deliberately a
// small, targeted set of direct table reads (not a new RPC) -- the same
// RLS that already let this page load the record governs these reads too,
// and none of them expose anything the viewer couldn't already see.
export async function getQualityReviewRecordContext({
  workspaceId,
  entityTypeId,
  recordId,
  effectiveUserId,
  supabase: injectedSupabase,
}: {
  workspaceId: string;
  entityTypeId: string;
  recordId: string;
  effectiveUserId?: string;
  supabase?: SupabaseServerClient;
}): Promise<QualityReviewRecordContext> {
  const supabase = injectedSupabase ?? (await createServerSupabaseClient());

  const { data: entityTypeRow, error: entityTypeError } = await supabase
    .from("entity_types")
    .select(
      "quality_review, quality_review_status_field_id, quality_review_draft_option_id, quality_review_finalized_option_id, author_person_field_id",
    )
    .eq("workspace_id", workspaceId)
    .eq("id", entityTypeId)
    .single<EntityTypeQualityReviewRow>();

  if (entityTypeError) {
    throw new Error(`Unable to load Quality Review context: ${entityTypeError.message}`);
  }

  if (!entityTypeRow.quality_review || !entityTypeRow.quality_review_status_field_id) {
    return { isQualityReviewType: false, isDraft: false, isFinalized: false, isReviewer: false };
  }

  const [{ data: statusField }, { data: recordRow, error: recordError }] = await Promise.all([
    supabase
      .from("field_definitions")
      .select("key")
      .eq("id", entityTypeRow.quality_review_status_field_id)
      .single<{ key: string }>(),
    supabase
      .from("entity_records")
      .select("values")
      .eq("workspace_id", workspaceId)
      .eq("id", recordId)
      .single<{ values: Record<string, unknown> }>(),
  ]);

  if (recordError || !statusField) {
    throw new Error("Unable to load this record's Quality Review status.");
  }

  const statusValue = recordRow.values[statusField.key];
  const isDraft = statusValue === entityTypeRow.quality_review_draft_option_id;
  const isFinalized = statusValue === entityTypeRow.quality_review_finalized_option_id;

  let isReviewer = false;
  if (effectiveUserId && entityTypeRow.author_person_field_id) {
    const { data: relationRow } = await supabase
      .from("entity_record_relation_values")
      .select("target_record_id")
      .eq("workspace_id", workspaceId)
      .eq("source_record_id", recordId)
      .eq("field_definition_id", entityTypeRow.author_person_field_id)
      .maybeSingle<{ target_record_id: string }>();

    if (relationRow?.target_record_id) {
      const { data: linkRow } = await supabase
        .from("entity_record_person_links")
        .select("user_id")
        .eq("workspace_id", workspaceId)
        .eq("entity_record_id", relationRow.target_record_id)
        .maybeSingle<{ user_id: string }>();
      isReviewer = linkRow?.user_id === effectiveUserId;
    }
  }

  return { isQualityReviewType: true, isDraft, isFinalized, isReviewer };
}

export type PersonQualityReviewHistoryEntry = {
  reviewEntityTypeId: string;
  reviewEntityTypeName: string;
  reviewRecordId: string;
  reviewDate: string;
  resultOptionId: string | null;
  resultLabel: string | null;
  resultColor: string | null;
  reviewerPersonRecordId: string | null;
  reviewerLabel: string | null;
};

type PersonQualityReviewHistoryRow = {
  review_entity_type_id: string;
  review_entity_type_name: string;
  review_record_id: string;
  review_date: string;
  result_option_id: string | null;
  result_label: string | null;
  result_color: string | null;
  reviewer_person_record_id: string | null;
  reviewer_label: string | null;
};

// Phase 12.3.2: the complete, uncapped, Finalized-only Review History for a
// Person -- a thin wrapper over list_person_quality_reviews_authorized,
// which does all authorization/visibility work (including per-row Reviewer
// redaction) in SQL. Never returns Notes or any other review content.
export async function listPersonQualityReviews({
  workspaceId,
  personRecordId,
  supabase: injectedSupabase,
}: {
  workspaceId: string;
  personRecordId: string;
  supabase?: SupabaseServerClient;
}): Promise<PersonQualityReviewHistoryEntry[]> {
  const supabase = injectedSupabase ?? (await createServerSupabaseClient());
  const { data, error } = await supabase.rpc("list_person_quality_reviews_authorized", {
    p_workspace_id: workspaceId,
    p_person_record_id: personRecordId,
  });

  if (error) {
    throw new Error(`Unable to load review history: ${error.message}`);
  }

  return ((data ?? []) as PersonQualityReviewHistoryRow[]).map((row) => ({
    reviewEntityTypeId: row.review_entity_type_id,
    reviewEntityTypeName: row.review_entity_type_name,
    reviewRecordId: row.review_record_id,
    reviewDate: row.review_date,
    resultOptionId: row.result_option_id,
    resultLabel: row.result_label,
    resultColor: row.result_color,
    reviewerPersonRecordId: row.reviewer_person_record_id,
    reviewerLabel: row.reviewer_label,
  }));
}

export async function reopenQualityReview({
  workspaceId,
  entityTypeId,
  recordId,
  supabase: injectedSupabase,
}: {
  workspaceId: string;
  entityTypeId: string;
  recordId: string;
  supabase?: SupabaseServerClient;
}): Promise<void> {
  const supabase = injectedSupabase ?? (await createServerSupabaseClient());
  const { error } = await supabase.rpc("reopen_quality_review_authorized", {
    p_workspace_id: workspaceId,
    p_entity_type_id: entityTypeId,
    p_record_id: recordId,
  });

  if (error) {
    throw new Error(error.message);
  }
}
