import { describe, expect, it } from "vitest";
import { buildMergePlan, type MergePreview } from "../../src/lib/core/merge";
import { DEFAULT_SETTINGS, type Settings } from "../../src/lib/core/types";

const settings: Settings = { ...DEFAULT_SETTINGS };
const blob = new Blob(["png"], { type: "image/png" });

function frame(name: string, digest: string, duration = 100) {
  return {
    id: `${name}#0`,
    name,
    duration,
    width: 2,
    height: 2,
    blob,
    digest
  };
}

function preview(): MergePreview {
  const current = { settings, frames: [frame("same.png", "h-same"), frame("diff.png", "h-a")], sourceHash: "cur" };
  const imported = {
    settings,
    frames: [
      frame("same.png", "h-same"),
      frame("diff.png", "h-b"),
      frame("dup.png", "h-b"),
      frame("only.png", "h-c")
    ],
    sourceHash: "imp"
  };
  return {
    current,
    imported,
    identical: [
      {
        name: "same.png",
        digest: "h-same",
        aliases: [],
        currentReferenceCount: 1,
        importedReferenceCount: 1,
        currentDuration: 100,
        importedDuration: 100
      }
    ],
    conflicts: [
      {
        name: "diff.png",
        current: frame("diff.png", "h-a"),
        imported: frame("diff.png", "h-b"),
        decision: "rename-import",
        defaultNewName: "diff_imported.png",
        newName: "diff_imported.png",
        currentReferenceCount: 1,
        importedReferenceCount: 1,
        importedAliases: ["dup.png"]
      }
    ],
    importedOnly: [{ name: "only.png", digest: "h-c", width: 2, height: 2, duration: 100, referenceCount: 1 }],
    referenceImpacts: [],
    stats: { currentAssets: 2, importedAssets: 3, finalAssets: 4, finalSequenceLength: 6 }
  };
}

describe("buildMergePlan", () => {
  it("同名同内容去重，同名不同内容重命名后保留两份", () => {
    const p = preview();
    const plan = buildMergePlan(p, []);
    expect(plan.assets.map((a) => a.name)).toEqual([
      "same.png",
      "diff.png",
      "diff_imported.png",
      "only.png"
    ]);
    expect(plan.order.map((o) => o.name)).toEqual([
      "same.png",
      "diff.png",
      "same.png",
      "diff_imported.png",
      "diff_imported.png",
      "only.png"
    ]);
    expect(plan.summary.deduplicatedReferences).toBe(2);
  });

  it("采用导入时覆盖同名当前资源，并让导入工程全部引用使用同一新目标", () => {
    const p = preview();
    const plan = buildMergePlan(p, [{ name: "diff.png", decision: "adopt-import" }]);
    expect(plan.assets.map((a) => a.name)).toEqual(["same.png", "diff.png", "only.png"]);
    expect(plan.order.filter((o) => o.name === "diff.png")).toHaveLength(3);
    expect(plan.summary.decisions).toEqual([{ name: "diff.png", decision: "adopt-import" }]);
  });

  it("保留当前不新增第二份资源，导入引用合并到当前同名帧", () => {
    const p = preview();
    const plan = buildMergePlan(p, [{ name: "diff.png", decision: "keep-current" }]);
    expect(plan.assets.map((a) => a.name)).toEqual(["same.png", "diff.png", "only.png"]);
    expect(plan.order.map((o) => o.name)).toEqual([
      "same.png",
      "diff.png",
      "same.png",
      "diff.png",
      "diff.png",
      "only.png"
    ]);
    expect(plan.summary.decisions).toEqual([{ name: "diff.png", decision: "keep-current" }]);
  });

  it("重命名目标为空或重复时拒绝生成悬空引用", () => {
    const p = preview();
    expect(() => buildMergePlan(p, [{ name: "diff.png", decision: "rename-import", newName: "same.png" }]))
      .toThrow(/重命名无效或重复/);
  });
});
