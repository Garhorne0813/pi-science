import { describe, expect, it } from "vitest";
import { workbookSheets } from "./xlsx";

describe("Office preview dependency compatibility", () => {
  it("loads all lazy renderer entry points after dependency overrides", async () => {
    const [{ renderAsync }, { init }, echarts, uuid] = await Promise.all([
      import("docx-preview"),
      import("pptx-preview"),
      import("echarts"),
      import("uuid"),
    ]);

    expect(renderAsync).toBeTypeOf("function");
    expect(init).toBeTypeOf("function");
    expect(echarts.version).toMatch(/^6\./);
    expect(uuid.v4()).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("round-trips an XLSX workbook through ExcelJS and the preview parser", async () => {
    const { Workbook } = await import("exceljs");
    const workbook = new Workbook();
    const sheet = workbook.addWorksheet("Results");
    sheet.addRow(["compound", "yield"]);
    sheet.addRow(["shikimate", 42]);
    sheet.mergeCells("A3:B3");
    sheet.getCell("A3").value = "merged note";
    const buffer = await workbook.xlsx.writeBuffer();
    const bytes = Uint8Array.from(buffer as unknown as Uint8Array).buffer;

    const parsed = await workbookSheets(bytes);

    expect(parsed).toHaveLength(1);
    expect(parsed[0].name).toBe("Results");
    expect(parsed[0].html).toContain("shikimate");
    expect(parsed[0].html).toContain("colspan=\"2\"");
  });
});
