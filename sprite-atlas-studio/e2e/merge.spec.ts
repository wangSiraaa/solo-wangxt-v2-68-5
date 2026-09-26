/**
 * e2e：两个本地工程合并的完整流程——
 * 预览（相同帧/冲突/新增/引用影响）→ 重命名策略合并 → 落库刷新 → 撤销 →
 * 导出再导入一致性 → 损坏图片不留下半合并数据。
 */
import { expect, test, type Page } from "@playwright/test";
import { PNG } from "pngjs";
import { readFileSync } from "node:fs";

/** 生成纯色 PNG（相同颜色 → 相同内容） */
function png(color: [number, number, number], size = 24): Buffer {
  const p = new PNG({ width: size, height: size });
  for (let i = 0; i < size * size; i++) {
    p.data[i * 4] = color[0];
    p.data[i * 4 + 1] = color[1];
    p.data[i * 4 + 2] = color[2];
    p.data[i * 4 + 3] = 255;
  }
  return PNG.sync.write(p);
}

const RED = png([220, 40, 40]);
const GREEN = png([40, 200, 60]);
const BLUE = png([60, 60, 230]);
const YELLOW = png([230, 210, 40]);

function file(name: string, buffer: Buffer) {
  return { name, mimeType: "image/png", buffer };
}

async function frameNames(page: Page): Promise<string[]> {
  return page.locator("#frame-list .frame-item .name").allInnerTexts();
}

test("工程合并：预览 → 重命名合并 → 刷新撤销 → 导出再导入一致 → 损坏回滚", async ({ page }) => {
  await page.goto("/");

  // ---- 工程 A：run_a(红) run_b(绿) + 片段 + 打包 ----
  await page.locator("#png-input").setInputFiles([file("run_a.png", RED), file("run_b.png", GREEN)]);
  await expect(page.locator("#frame-list .frame-item")).toHaveCount(2);
  await page.locator("#create-clip-btn").click();
  await expect(page.locator("#clips-panel .clip-item")).toHaveCount(1);
  await page.locator("#pack-btn").click();
  await expect(page.locator("#atlas-table tbody tr")).toHaveCount(2);

  // ---- 工程 B：run_a(红·相同) run_b(蓝·同名不同内容) run_c(黄·新增) + 片段 ----
  await page.locator(".project-bar input[type=text]").fill("工程B");
  await page.locator("#new-project-btn").click();
  await expect(page.locator("#frame-list .frame-item")).toHaveCount(0);
  await page
    .locator("#png-input")
    .setInputFiles([file("run_a.png", RED), file("run_b.png", BLUE), file("run_c.png", YELLOW)]);
  await expect(page.locator("#frame-list .frame-item")).toHaveCount(3);
  await page.locator("#create-clip-btn").click();
  await expect(page.locator("#clips-panel .clip-item")).toHaveCount(1);

  // ---- 切回工程 A，发起合并 ----
  await page.locator("#project-select").selectOption({ index: 0 });
  await expect(page.locator("#frame-list .frame-item")).toHaveCount(2);
  await page.locator("#merge-btn").click();
  await expect(page.locator("#merge-dialog")).toBeVisible();
  await page.locator("#merge-source-select").selectOption({ index: 1 });
  await page.locator("#merge-preview-btn").click();

  // 预览：相同 1 / 冲突 1 / 新增 1，片段引用影响可见
  await expect(page.locator("#preview-identical li")).toHaveCount(1);
  await expect(page.locator("#preview-identical")).toContainText("run_a.png");
  await expect(page.locator("#conflict-list .conflict")).toHaveCount(1);
  await expect(page.locator("#conflict-list")).toContainText("run_b.png");
  await expect(page.locator("#preview-additions li")).toHaveCount(1);
  await expect(page.locator("#preview-additions")).toContainText("run_c.png");
  await expect(page.locator("#clip-impact-list")).toContainText("片段_2"); // 导入片段重名自动改名
  await expect(page.locator("#clip-impact-list")).toContainText("run_b_2.png"); // 引用随重命名同步

  // 批量规则：全部重命名导入项（默认即重命名，显式点一次）
  await page.getByRole("button", { name: "全部重命名导入项" }).click();
  await page.locator("#merge-confirm-btn").click();
  await expect(page.locator("#merge-dialog")).toBeHidden();

  // 合并结果：run_b 保留两份（重命名），run_c 追加
  await expect(page.locator("#frame-list .frame-item")).toHaveCount(4);
  expect(await frameNames(page)).toEqual(["run_a.png", "run_b.png", "run_b_2.png", "run_c.png"]);
  // 图集已重打包
  await expect(page.locator("#atlas-table tbody tr")).toHaveCount(4);
  // 片段：当前 1 + 导入改名 1
  await expect(page.locator("#clips-panel .clip-item")).toHaveCount(2);
  // 合并记录：带来源摘要
  await expect(page.locator("#merge-history-panel .record")).toHaveCount(1);
  await expect(page.locator("#merge-history-panel")).toContainText("工程B");
  await expect(page.locator("#merge-history-panel")).toContainText("相同 1 · 冲突 1 · 新增 1");
  await expect(page.locator("#merge-history-panel")).toContainText("run_b.png：重命名 → run_b_2.png");

  // ---- 导出 JSON：冲突决策与片段随文件带出 ----
  const [jsonDownload] = await Promise.all([
    page.waitForEvent("download"),
    page.locator("#export-json-btn").click()
  ]);
  const exported = JSON.parse(readFileSync(await jsonDownload.path(), "utf-8"));
  expect(exported.meta.frameOrder).toEqual(["run_a.png", "run_b.png", "run_b_2.png", "run_c.png"]);
  expect(exported.meta.mergeHistory).toHaveLength(1);
  expect(exported.meta.mergeHistory[0].decisions).toEqual({ "run_b.png": "rename" });
  expect(exported.meta.mergeHistory[0].renames).toEqual({ "run_b.png": "run_b_2.png" });
  expect(exported.meta.clips.map((c: { name: string }) => c.name)).toEqual(["片段", "片段_2"]);

  // ---- 刷新后仍可撤销最近合并 ----
  await page.reload();
  await expect(page.locator("#frame-list .frame-item")).toHaveCount(4);
  await expect(page.locator("#merge-history-panel .record")).toHaveCount(1);
  await page.locator("#undo-merge-btn").click();
  await expect(page.locator("#frame-list .frame-item")).toHaveCount(2);
  expect(await frameNames(page)).toEqual(["run_a.png", "run_b.png"]);
  await expect(page.locator("#clips-panel .clip-item")).toHaveCount(1);
  await expect(page.locator("#merge-history-panel")).toContainText("已撤销");

  // 再次刷新：撤销状态持久
  await page.reload();
  await expect(page.locator("#frame-list .frame-item")).toHaveCount(2);
  await expect(page.locator("#merge-history-panel")).toContainText("已撤销");

  // ---- 导入 JSON 工程：帧顺序 / 图集 / 冲突决策一致 ----
  await page.locator("#json-input").setInputFiles({
    name: "atlas.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(exported))
  });
  await expect(page.locator("#frame-list .frame-item")).toHaveCount(4);
  expect(await frameNames(page)).toEqual(["run_a.png", "run_b.png", "run_b_2.png", "run_c.png"]);
  await expect(page.locator("#atlas-table tbody tr")).toHaveCount(4);
  // 图集布局一致（导出的矩形与重新导入后表格一致）
  const rows = page.locator("#atlas-table tbody tr");
  for (let i = 0; i < 4; i++) {
    const name = exported.meta.frameOrder[i];
    await expect(rows.nth(i).locator("td").nth(1)).toHaveText(name);
    const f = exported.frames[name].frame;
    for (const [col, val] of [
      [2, f.x],
      [3, f.y],
      [4, f.w],
      [5, f.h]
    ] as const) {
      await expect(rows.nth(i).locator("td").nth(col)).toHaveText(String(val));
    }
  }
  // 冲突决策一致（导入的历史记录展示但不可撤销）
  await expect(page.locator("#merge-history-panel")).toContainText("run_b.png：重命名 → run_b_2.png");
  await expect(page.locator("#merge-history-panel")).toContainText("导入的历史（不可撤销）");

  // ---- 损坏图片：合并失败且不留下半合并数据 ----
  const corruptJson = {
    frames: {
      "x.png": {
        frame: { x: 0, y: 0, w: 8, h: 8 },
        rotated: false,
        trimmed: false,
        spriteSourceSize: { x: 0, y: 0, w: 8, h: 8 },
        sourceSize: { w: 8, h: 8 },
        duration: 100
      }
    },
    meta: {
      app: "sprite-atlas-studio",
      version: "1.0.0",
      image: "atlas.png",
      size: { w: 8, h: 8 },
      frameOrder: ["x.png"],
      settings: { trim: false, padding: 0, maxSize: 64, pot: false },
      totalDuration: 100,
      atlasDataURL: "data:image/png;base64,AAAAcorruptnotapng"
    }
  };
  await page.locator("#merge-btn").click();
  await page.getByRole("radio", { name: "JSON 文件" }).check();
  await page.locator("#merge-file-input").setInputFiles({
    name: "corrupt.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(corruptJson))
  });
  await page.locator("#merge-preview-btn").click();
  await expect(page.locator("#merge-errors")).toBeVisible();
  await expect(page.locator("#merge-confirm-btn")).toBeHidden(); // 预览失败，无法确认
  await page.getByRole("button", { name: "取消" }).click();
  // 无任何半合并数据
  await expect(page.locator("#frame-list .frame-item")).toHaveCount(4);
  await expect(page.locator("#merge-history-panel .record")).toHaveCount(1);
});
