import { describe, expect, it } from "vitest";
import { parseCsvCellValue, suggestColumnMappings, validateColumnMapping } from "./record-import";
import type { FieldDefinition } from "./types";

function field(overrides: Partial<FieldDefinition> & Pick<FieldDefinition, "id" | "name" | "type">): FieldDefinition {
  return {
    workspaceId: "w1",
    entityTypeId: "e1",
    key: `fld_${overrides.id}`,
    slug: overrides.name.toLowerCase(),
    required: false,
    position: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("parseCsvCellValue", () => {
  it("trims text values, matching normal record form behavior", () => {
    const result = parseCsvCellValue(field({ id: "f1", name: "Name", type: "text" }), "  Acme  ");
    expect(result).toEqual({ success: true, value: "Acme" });
  });

  it("treats a blank text cell as null", () => {
    const result = parseCsvCellValue(field({ id: "f1", name: "Name", type: "text" }), "   ");
    expect(result).toEqual({ success: true, value: null });
  });

  it("parses a valid number", () => {
    const result = parseCsvCellValue(field({ id: "f1", name: "Revenue", type: "number" }), "4200000");
    expect(result).toEqual({ success: true, value: 4200000 });
  });

  it("rejects an invalid number with no locale guessing", () => {
    const result = parseCsvCellValue(field({ id: "f1", name: "Revenue", type: "number" }), "4,200,000");
    expect(result.success).toBe(false);
  });

  it("accepts a strict YYYY-MM-DD date", () => {
    const result = parseCsvCellValue(field({ id: "f1", name: "Start Date", type: "date" }), "2026-03-04");
    expect(result).toEqual({ success: true, value: "2026-03-04" });
  });

  it("rejects an ambiguous date format", () => {
    const result = parseCsvCellValue(field({ id: "f1", name: "Start Date", type: "date" }), "03/04/2026");
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toMatch(/YYYY-MM-DD/);
  });

  it.each(["true", "TRUE", "yes", "Yes", "1"])("accepts %s as boolean true", (raw) => {
    const result = parseCsvCellValue(field({ id: "f1", name: "Active", type: "boolean" }), raw);
    expect(result).toEqual({ success: true, value: true });
  });

  it.each(["false", "FALSE", "no", "No", "0"])("accepts %s as boolean false", (raw) => {
    const result = parseCsvCellValue(field({ id: "f1", name: "Active", type: "boolean" }), raw);
    expect(result).toEqual({ success: true, value: false });
  });

  it("rejects an unrecognized boolean value", () => {
    const result = parseCsvCellValue(field({ id: "f1", name: "Active", type: "boolean" }), "maybe");
    expect(result.success).toBe(false);
  });
});

describe("suggestColumnMappings", () => {
  it("suggests an exact, case-insensitive, trimmed field-name match", () => {
    const fields = [
      field({ id: "f1", name: "Client Name", type: "text" }),
      field({ id: "f2", name: "Industry", type: "text" }),
    ];
    const suggestions = suggestColumnMappings(["  industry  ", "Unmapped Column"], fields);

    expect(suggestions).toEqual([
      { columnIndex: 0, fieldId: "f2" },
      { columnIndex: 1, fieldId: null },
    ]);
  });

  it("never guesses a partial or semantic match", () => {
    const fields = [field({ id: "f1", name: "Client Name", type: "text" })];
    const suggestions = suggestColumnMappings(["Name"], fields);

    expect(suggestions).toEqual([{ columnIndex: 0, fieldId: null }]);
  });
});

describe("validateColumnMapping", () => {
  const fields = [
    field({ id: "f1", name: "Name", type: "text", required: true }),
    field({ id: "f2", name: "Industry", type: "text" }),
  ];

  it("passes a valid, complete mapping", () => {
    const errors = validateColumnMapping(fields, [
      { columnIndex: 0, fieldId: "f1" },
      { columnIndex: 1, fieldId: "f2" },
    ]);
    expect(errors).toEqual([]);
  });

  it("rejects two columns mapped to the same field", () => {
    const errors = validateColumnMapping(fields, [
      { columnIndex: 0, fieldId: "f1" },
      { columnIndex: 1, fieldId: "f1" },
    ]);
    expect(errors.some((error) => error.includes("more than one column"))).toBe(true);
  });

  it("fails clearly when a required field has no mapped column", () => {
    const errors = validateColumnMapping(fields, [{ columnIndex: 0, fieldId: "f2" }]);
    expect(errors.some((error) => error.includes("Name") && error.includes("required"))).toBe(true);
  });

  it("flags a mapping that targets a field no longer in the active set", () => {
    const errors = validateColumnMapping(fields, [
      { columnIndex: 0, fieldId: "f1" },
      { columnIndex: 1, fieldId: "archived-field" },
    ]);
    expect(errors.some((error) => error.includes("no longer exists"))).toBe(true);
  });
});
