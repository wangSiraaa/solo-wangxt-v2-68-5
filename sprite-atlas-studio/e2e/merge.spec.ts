import { expect, test, type Page } from "@playwright/test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

const ASSETS = join(dirname(fileURLToPath(import.meta.url)), "..", "test-assets");

function asset(name: string): string {
  return join(ASSETS, name);
}

async function exportEmbeddedJson(page: Page): Promise<any> {
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.locator("#export-json-btn").click()
  ]);
  const path = await download.path();
  return JSON.parse(readFileSync(path!, "utf-8"));
}

async function importJson(page: Page, json: any, filename = "atlas.json"): Promise<void> {
  await page.locator("#json-input").setInputFiles({
    name: filename,
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(json))
  });
}

async function frameNames(page: Page): Promise<string[]> {
  return page.locator("#frame-list .frame-item .name").allInnerTexts();
}

test("工程合并：内容去重、冲突重命名、内部引用同步、原子回滚、刷新撤销和再导入一致", async ({
  page
}) => {
  await page.goto("/");

  // 当前工程：A=walk_01，B=walk_02，D=walk_04，E=walk_05。
  await page
    .locator("#png-input")
    .setInputFiles([asset("walk_01.png"), asset("walk_02.png"), asset("walk_04.png"), asset("walk_05.png")]);
  await page.locator("#pack-btn").click();
  await expect(page.locator("#atlas-image")).toBeVisible();
  const currentJson = await exportEmbeddedJson(page);

  // 导入工程：A 同名同内容、B/E 同名不同内容、C 独有；B、E 在内部播放顺序中各出现两次。
  await page.getByRole("button", { name: "清空" }).click();
  await page.locator("#png-input").setInputFiles([
    asset("walk_01.png"),
    asset("walk_02.png"),
    asset("walk_03.png"),
    asset("walk_05.png"),
    asset("walk_02.png"),
    asset("walk_05.png")
  ]);
  await page.locator("#pack-btn").click();
  const importedJson = await exportEmbeddedJson(page);

  // 恢复当前工程并打开合并预览。
  await page.getByRole("button", { name: "清空" }).click();
  await importJson(page, currentJson, "current.json");
  await expect(page.locator("#frame-list .frame-item")).toHaveCount(4);

  await page.locator("#open-merge-btn").click();
  await page.locator("#merge-project-input").setInputFiles({
    name: "imported.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(importedJson))
  });

  await expect(page.locator("#merge-stats")).toContainText("合并后 7 资源 / 10 引用");
  await expect(page.locator("#merge-identical-table tr")).toHaveCount(2);
  await expect(page.locator("[data-conflict='walk_02.png']")).toBeVisible();
  await expect(page.locator("[data-conflict='walk_05.png']")).toBeVisible();
  await expect(page.locator("#merge-reference-impacts")).toContainText("walk_02.png");

  // 先批量选择“保留当前”，再单项覆盖 B 为“采用导入”、E 为“重命名导入”。
  await page.getByRole("button", { name: "全部保留当前" }).click();
  const adoptedRadio = page.locator("[data-conflict='walk_02.png'] label", { hasText: "采用导入" }).locator("input");
  await adoptedRadio.check();
  const renamedRadio = page.locator("[data-conflict='walk_05.png'] label", { hasText: "重命名导入" }).locator("input");
  await renamedRadio.check();

  await page.locator("#merge-confirm-btn").click();
  await expect(page.locator("#merge-summary")).toContainText("合并 6 资源 / 10 引用");
  await expect(page.locator("#undo-merge-btn")).toBeEnabled();

  const names = await frameNames(page);
  expect(names).toEqual([
    "walk_01.png",
    "walk_02.png",
    "walk_04.png",
    "walk_05.png",
    "walk_01.png",
    "walk_02.png",
    "walk_03.png",
    "walk_05_imported.png",
    "walk_05_imported.png",
    "walk_03.png"
  ]);
  await expect(page.locator("#atlas-table tbody tr")).toHaveCount(10);
  await expect(page.locator("#atlas-image")).toBeVisible();

  // 导出再导入：帧顺序、图集布局与冲突决策摘要一致。
  await page.waitForTimeout(800);
  const mergedJson = await exportEmbeddedJson(page);
  expect(mergedJson.meta.frameOrder).toEqual(names);
  expect(mergedJson.meta.frameEntries.map((f: any) => f.name)).toEqual(names);
  expect(mergedJson.meta.mergeSummary.decisions).toEqual([
    { name: "walk_02.png", decision: "adopt-import" },
    { name: "walk_05.png", decision: "rename-import", newName: "walk_05_imported.png" }
  ]);
  const mergedRects = mergedJson.meta.frameEntries.map((f: any) => [
    f.frame.x, f.frame.y, f.frame.w, f.frame.h
  ]);

  await page.getByRole("button", { name: "清空" }).click();
  await importJson(page, mergedJson, "merged-roundtrip.json");
  expect(await frameNames(page)).toEqual(names);
  const roundtrip = await exportEmbeddedJson(page);
  expect(roundtrip.meta.frameEntries.map((f: any) => [f.frame.x, f.frame.y, f.frame.w, f.frame.h]))
    .toEqual(mergedRects);
  expect(roundtrip.meta.mergeSummary.decisions).toEqual(mergedJson.meta.mergeSummary.decisions);
  await expect(page.locator("#undo-merge-btn")).toBeDisabled();
  await expect(page.locator("#merge-summary")).toContainText("再导入后不可撤销");

  // 刷新后最近合并仍可撤销，恢复到合并前的 4 个序列引用。
  await page.reload();
  await expect(page.locator("#undo-merge-btn")).toBeEnabled();
  await page.locator("#undo-merge-btn").click();
  await expect(page.locator("#frame-list .frame-item")).toHaveCount(4);
  expect(await frameNames(page)).toEqual(["walk_01.png", "walk_02.png", "walk_04.png", "walk_05.png"]);
  await expect(page.locator("#merge-summary")).toHaveCount(0);
  await expect(page.locator("#undo-merge-btn")).toBeDisabled();
});

test("损坏图片或打包失败时不留下半合并数据", async ({ page }) => {
  await page.goto("/");
  await page.locator("#png-input").setInputFiles([asset("walk_01.png"), asset("walk_04.png")]);
  await page.locator("#pack-btn").click();
  const currentJson = await exportEmbeddedJson(page);

  await page.getByRole("button", { name: "清空" }).click();
  await page.locator("#png-input").setInputFiles([asset("walk_02.png")]);
  await page.locator("#pack-btn").click();
  const importedJson = await exportEmbeddedJson(page);
  importedJson.meta.atlasDataURL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAyAAAAJYCAYAAAC==";

  await page.getByRole("button", { name: "清空" }).click();
  await importJson(page, currentJson, "current-before.json");
  const beforeNames = await frameNames(page);

  await page.locator("#open-merge-btn").click();
  await page.locator("#merge-project-input").setInputFiles({
    name: "broken.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(importedJson))
  });

  await expect(page.locator("#merge-preview-error")).toContainText("图片损坏");
  await page.keyboard.press("Escape");
  expect(await frameNames(page)).toEqual(beforeNames);
  await expect(page.locator("#undo-merge-btn")).toBeDisabled();
  await expect(page.locator("#atlas-table tbody tr")).toHaveCount(2);

  await page.reload();
  expect(await frameNames(page)).toEqual(beforeNames);
  await expect(page.locator("#atlas-table tbody tr")).toHaveCount(2);
  await expect(page.locator("#undo-merge-btn")).toBeDisabled();
});
