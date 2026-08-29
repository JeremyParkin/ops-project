import { describe, expect, it } from "vitest";
import { parseCsvFile } from "./csv-parsing";

describe("parseCsvFile", () => {
  it("parses a simple UTF-8 CSV with a header row", () => {
    const result = parseCsvFile("Name,Industry\nAcme,Manufacturing\nGlobex,Technology\n");

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.headers).toEqual(["Name", "Industry"]);
    expect(result.data.rows).toEqual([
      ["Acme", "Manufacturing"],
      ["Globex", "Technology"],
    ]);
  });

  it("handles quoted values with commas inside them", () => {
    const result = parseCsvFile('Name,Notes\nAcme,"Manufacturing, industrial"\n');

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.rows).toEqual([["Acme", "Manufacturing, industrial"]]);
  });

  it("handles CRLF line endings", () => {
    const result = parseCsvFile("Name,Industry\r\nAcme,Manufacturing\r\nGlobex,Technology\r\n");

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.rows).toHaveLength(2);
  });

  it("handles LF line endings", () => {
    const result = parseCsvFile("Name,Industry\nAcme,Manufacturing\n");

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.rows).toHaveLength(1);
  });

  it("preserves blank cells", () => {
    const result = parseCsvFile("Name,Industry,Region\nAcme,,Canada\n");

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.rows).toEqual([["Acme", "", "Canada"]]);
  });

  it("strips a leading UTF-8 BOM", () => {
    const result = parseCsvFile("﻿Name,Industry\nAcme,Manufacturing\n");

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.headers).toEqual(["Name", "Industry"]);
  });

  it("rejects malformed CSV (inconsistent column count)", () => {
    const result = parseCsvFile("Name,Industry\nAcme,Manufacturing,Extra\n");

    expect(result.success).toBe(false);
  });

  it("rejects a file with no data rows", () => {
    const result = parseCsvFile("Name,Industry\n");

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toMatch(/no data rows/i);
  });

  it("rejects an empty file", () => {
    const result = parseCsvFile("");

    expect(result.success).toBe(false);
  });

  it("rejects duplicate CSV headers explicitly", () => {
    const result = parseCsvFile("Name,Name\nAcme,Acme Corp\n");

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toMatch(/duplicate column headers/i);
    expect(result.error).toContain("Name");
  });

  it("rejects a blank column header", () => {
    const result = parseCsvFile("Name,\nAcme,Foo\n");

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toMatch(/blank column header/i);
  });

  it("skips fully blank lines", () => {
    const result = parseCsvFile("Name,Industry\nAcme,Manufacturing\n\nGlobex,Technology\n");

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.rows).toHaveLength(2);
  });
});
