// Phase 12.3.2: pure-function coverage for withoutQualityReviewSubjectGroups,
// the presentation-only Related dedup applied on a Person's own record page.
// Live/UI coverage of the actual Person-page wiring (Review history present,
// Related still rendered without the duplicate group, and non-Person pages
// completely unaffected) lives in tests/e2e/person-review-history.spec.ts;
// this file isolates the exact filtering rule itself with constructed
// fixtures, no database required.
import { describe, expect, it } from "vitest";
import { withoutQualityReviewSubjectGroups, type IncomingRelationGroup } from "./record-repository";
import type { EntityType, FieldDefinition } from "./types";

function entityType(overrides: Partial<EntityType> = {}): EntityType {
  return {
    id: "et-1",
    workspaceId: "ws-1",
    name: "Test Type",
    slug: "test-type",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function field(overrides: Partial<FieldDefinition> = {}): FieldDefinition {
  return {
    id: "field-1",
    workspaceId: "ws-1",
    entityTypeId: "et-1",
    key: "field_1",
    name: "Field",
    slug: "field",
    type: "relation",
    required: false,
    position: 1,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function group(overrides: Partial<IncomingRelationGroup> = {}): IncomingRelationGroup {
  return {
    sourceEntityType: entityType(),
    sourceFields: [],
    relationField: field(),
    records: [],
    ...overrides,
  };
}

describe("withoutQualityReviewSubjectGroups", () => {
  it("suppresses only the group whose relation field is the QR type's own subject_person_field_id", () => {
    const subjectField = field({ id: "subject-field" });
    const qrType = entityType({ id: "qr-type", qualityReview: true, subjectPersonFieldId: "subject-field" });
    const subjectGroup = group({ sourceEntityType: qrType, relationField: subjectField });

    expect(withoutQualityReviewSubjectGroups([subjectGroup])).toEqual([]);
  });

  it("keeps the Reviewer/author relation group from the same QR type", () => {
    const qrType = entityType({ id: "qr-type", qualityReview: true, subjectPersonFieldId: "subject-field" });
    const reviewerField = field({ id: "reviewer-field" });
    const reviewerGroup = group({ sourceEntityType: qrType, relationField: reviewerField });

    expect(withoutQualityReviewSubjectGroups([reviewerGroup])).toEqual([reviewerGroup]);
  });

  it("keeps a non-QR relation group even if its field id happens to match another type's subject field id", () => {
    const nonQrType = entityType({ id: "non-qr-type", qualityReview: false, subjectPersonFieldId: "subject-field" });
    const matchingField = field({ id: "subject-field" });
    const nonQrGroup = group({ sourceEntityType: nonQrType, relationField: matchingField });

    // qualityReview=false must be enough on its own to keep the group,
    // proving suppression requires BOTH conditions together, not just a
    // field-id coincidence.
    expect(withoutQualityReviewSubjectGroups([nonQrGroup])).toEqual([nonQrGroup]);
  });

  it("keeps unrelated Person relation groups and groups from non-Quality-Review sensitive types untouched", () => {
    const plainType = entityType({ id: "plain-type" });
    const plainGroup = group({ sourceEntityType: plainType, relationField: field({ id: "plain-field" }) });

    expect(withoutQualityReviewSubjectGroups([plainGroup])).toEqual([plainGroup]);
  });

  it("suppresses the subject group independently for each of multiple Quality Review EntityTypes", () => {
    const typeA = entityType({ id: "qr-a", name: "Quality Review", qualityReview: true, subjectPersonFieldId: "subject-a" });
    const typeB = entityType({ id: "qr-b", name: "Peer Feedback", qualityReview: true, subjectPersonFieldId: "subject-b" });

    const subjectGroupA = group({ sourceEntityType: typeA, relationField: field({ id: "subject-a" }) });
    const reviewerGroupA = group({ sourceEntityType: typeA, relationField: field({ id: "reviewer-a" }) });
    const subjectGroupB = group({ sourceEntityType: typeB, relationField: field({ id: "subject-b" }) });
    const reviewerGroupB = group({ sourceEntityType: typeB, relationField: field({ id: "reviewer-b" }) });

    const result = withoutQualityReviewSubjectGroups([subjectGroupA, reviewerGroupA, subjectGroupB, reviewerGroupB]);

    expect(result).toEqual([reviewerGroupA, reviewerGroupB]);
  });

  it("returns an empty array unchanged", () => {
    expect(withoutQualityReviewSubjectGroups([])).toEqual([]);
  });
});
