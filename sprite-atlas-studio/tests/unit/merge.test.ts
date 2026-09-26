import { describe, expect, it } from "vitest";
import {
  applyMergePlan,
  buildMergePlan,
  buildMergePreview,
  uniqueName,
  validateProjectData,
  MergeError,
  type MergeProjectData
} from "../../src/lib/core/merge";

function frame(id: string, name: string, hash: string) {
  return { id, name, hash, duration: 100, width: 32, height: 32 };
}

function project(name: string, frames: ReturnType<typeof frame>[], clips: Array<{ id: string; name: string; frameIds: string[] }> = []): MergeProjectData {
  return { name, frames, clips };
}

describe("validateProjectData", () => {
  it("拒绝空工程 / 重名帧 / 重名片段 / 悬空引用", () => {
    expect(() => validateProjectData(project("A", []), "当前工程")).toThrow(/没有任何帧/);
    expect(() =>
      validateProjectData(project("A", [frame("1", "a.png", "h1"), frame("2", "a.png", "h2")]), "当前工程")
    ).toThrow(/重名帧/);
    expect(() =>
      validateProjectData(
        project("A", [frame("1", "a.png", "h1")], [
          { id: "c1", name: "x", frameIds: ["1"] },
          { id: "c2", name: "x", frameIds: ["1"] }
        ]),
        "当前工程"
      )
    ).toThrow(/重名片段/);
    expect(() =>
      validateProjectData(project("A", [frame("1", "a.png", "h1")], [{ id: "c1", name: "x", frameIds: ["nope"] }]), "导入工程")
    ).toThrow(MergeError);
    expect(() =>
      validateProjectData(project("A", [frame("1", "a.png", "h1")], [{ id: "c1", name: "x", frameIds: ["nope"] }]), "导入工程")
    ).toThrow(/不存在的帧/);
  });
});

describe("buildMergePreview", () => {
  it("按内容摘要识别相同帧、按名称识别冲突、其余为新增", () => {
    const current = project("cur", [frame("c1", "run_01.png", "H1"), frame("c2", "jump.png", "H2")], [
      { id: "cc1", name: "run", frameIds: ["c1"] }
    ]);
    const imported = project(
      "imp",
      [frame("i1", "run_01.png", "H1"), frame("i2", "jump.png", "H9"), frame("i3", "walk.png", "H3")],
      [
        { id: "ic1", name: "run", frameIds: ["i1"] },
        { id: "ic2", name: "combo", frameIds: ["i2", "i3"] }
      ]
    );
    const preview = buildMergePreview(current, imported);
    expect(preview.identical.map((e) => e.name)).toEqual(["run_01.png"]);
    expect(preview.identical[0]!.importedReferencedBy).toEqual(["run"]);
    expect(preview.conflicts.map((e) => e.name)).toEqual(["jump.png"]);
    expect(preview.conflicts[0]!.currentReferencedBy).toEqual([]);
    expect(preview.conflicts[0]!.importedReferencedBy).toEqual(["combo"]);
    expect(preview.additions.map((e) => e.name)).toEqual(["walk.png"]);
    expect(preview.additions[0]!.duplicateOf).toBeNull();
  });

  it("内容相同但名称不同的新增帧会标注 duplicateOf", () => {
    const current = project("cur", [frame("c1", "a.png", "H1")]);
    const imported = project("imp", [frame("i1", "b.png", "H1")]);
    const preview = buildMergePreview(current, imported);
    expect(preview.additions[0]!.duplicateOf).toBe("a.png");
  });
});

describe("uniqueName", () => {
  it("生成不冲突的名称", () => {
    expect(uniqueName("a.png", new Set())).toBe("a.png");
    expect(uniqueName("a.png", new Set(["a.png"]))).toBe("a_2.png");
    expect(uniqueName("a.png", new Set(["a.png", "a_2.png"]))).toBe("a_3.png");
    expect(uniqueName("片段", new Set(["片段"]))).toBe("片段_2");
  });
});

describe("buildMergePlan + applyMergePlan", () => {
  const current = project(
    "cur",
    [frame("c1", "run_01.png", "H1"), frame("c2", "jump.png", "H2")],
    [{ id: "cc1", name: "run", frameIds: ["c1"] }]
  );
  const imported = project(
    "imp",
    [frame("i1", "run_01.png", "H1"), frame("i2", "jump.png", "H9"), frame("i3", "walk.png", "H3")],
    [
      { id: "ic1", name: "run", frameIds: ["i1", "i2"] },
      { id: "ic2", name: "combo", frameIds: ["i2", "i2", "i3"] }
    ]
  );

  it("同名同内容：只保留一份，导入方引用合并到现有帧", () => {
    const plan = buildMergePlan(current, imported, "rename");
    const applied = applyMergePlan(current, imported, plan);
    // 相同帧被去重，不新增
    expect(applied.frames.filter((f) => f.name === "run_01.png")).toHaveLength(1);
    expect(applied.frames.find((f) => f.name === "run_01.png")!.id).toBe("c1");
    // 片段：当前 1 个 + 导入 2 个（run 重名 → 改名 run_2）
    expect(applied.clips).toHaveLength(3);
    // 导入片段中对被去重帧的引用指向当前帧 id
    const run2 = applied.clips.find((c) => c.name === "run_2")!;
    expect(run2.frameIds[0]).toBe("c1");
    // 去重的帧不需要导入方提供图片
    expect(applied.report.neededHashes).not.toContain("H1");
    expect(applied.report.summary.identical).toBe(1);
  });

  it("片段名冲突时导入片段自动改名，且引用全部重映射", () => {
    const plan = buildMergePlan(current, imported, "rename");
    const applied = applyMergePlan(current, imported, plan);
    const names = applied.clips.map((c) => c.name);
    expect(names).toContain("run"); // 当前片段
    expect(names.filter((n) => n === "run")).toHaveLength(1);
    expect(names).toContain("run_2"); // 导入片段改名
    expect(names).toContain("combo");
    // 导入 run_2 片段：[i1→c1（去重）, i2→新帧（重命名）]
    const run2 = applied.clips.find((c) => c.name === "run_2")!;
    const renamedFrame = applied.frames.find((f) => f.name === "jump_2.png")!;
    expect(run2.frameIds).toEqual(["c1", renamedFrame.id]);
    // combo 中重复引用 i2 也都指向新帧
    const combo = applied.clips.find((c) => c.name === "combo")!;
    const walk = applied.frames.find((f) => f.name === "walk.png")!;
    expect(combo.frameIds).toEqual([renamedFrame.id, renamedFrame.id, walk.id]);
  });

  it("同名不同内容按重命名策略保留两份，导入工程内部多处引用同步更新", () => {
    const plan = buildMergePlan(current, imported, "rename");
    const applied = applyMergePlan(current, imported, plan);
    const names = applied.frames.map((f) => f.name);
    expect(names).toEqual(["run_01.png", "jump.png", "jump_2.png", "walk.png"]);
    // 当前帧内容未被触碰
    expect(applied.frames.find((f) => f.name === "jump.png")!.hash).toBe("H2");
    expect(applied.frames.find((f) => f.name === "jump_2.png")!.hash).toBe("H9");
    expect(applied.report.renames).toEqual({ "jump.png": "jump_2.png" });
    expect(applied.report.decisions).toEqual({ "jump.png": "rename" });
    // 多处引用同步：clipResults 中 combo 的引用都指向 jump_2.png
    const comboResult = applied.report.clipResults.find((c) => c.importedName === "combo")!;
    expect(comboResult.references.map((r) => r.finalFrameName)).toEqual(["jump_2.png", "jump_2.png", "walk.png"]);
    expect(comboResult.references[0]!.effect).toBe("rename");
  });

  it("批量规则应用后仍可单项覆盖", () => {
    const cur2 = project("cur", [frame("c1", "a.png", "H1"), frame("c2", "b.png", "H2")]);
    const imp2 = project("imp", [frame("i1", "a.png", "H7"), frame("i2", "b.png", "H8")], [
      { id: "ic", name: "refs", frameIds: ["i1", "i2"] }
    ]);
    // 批量：全部保留当前；单项覆盖：b.png 改为重命名
    const plan = buildMergePlan(cur2, imp2, "keep-current", { "b.png": { action: "rename" } });
    const applied = applyMergePlan(cur2, imp2, plan);
    const names = applied.frames.map((f) => f.name);
    expect(names).toEqual(["a.png", "b.png", "b_2.png"]);
    // a.png 保留当前（导入帧被丢弃），引用改指当前帧
    const refs = applied.clips.find((c) => c.name === "refs")!;
    const aCur = applied.frames.find((f) => f.name === "a.png")!;
    const b2 = applied.frames.find((f) => f.name === "b_2.png")!;
    expect(refs.frameIds).toEqual([aCur.id, b2.id]);
    expect(applied.frames.find((f) => f.name === "a.png")!.hash).toBe("H1");
    expect(applied.report.decisions).toEqual({ "a.png": "keep-current", "b.png": "rename" });
  });

  it("采用导入：当前帧内容被替换（id 不变），当前片段引用保持有效", () => {
    const plan = buildMergePlan(current, imported, "use-imported");
    const applied = applyMergePlan(current, imported, plan);
    const jump = applied.frames.find((f) => f.name === "jump.png")!;
    expect(jump.id).toBe("c2");
    expect(jump.hash).toBe("H9"); // 内容换成导入的
    // 当前片段 run 仍引用 c1（未受影响）；replace 影响记录在报告中
    expect(applied.report.replacedFrameIds).toEqual(["c2"]);
    expect(applied.report.neededHashes).toContain("H9");
    expect(applied.report.decisions).toEqual({ "jump.png": "use-imported" });
  });

  it("保留当前：导入帧被丢弃，其引用改指当前帧", () => {
    const plan = buildMergePlan(current, imported, "keep-current");
    const applied = applyMergePlan(current, imported, plan);
    expect(applied.frames.map((f) => f.name)).toEqual(["run_01.png", "jump.png", "walk.png"]);
    const run2 = applied.clips.find((c) => c.name === "run_2")!;
    expect(run2.frameIds).toEqual(["c1", "c2"]); // i1 去重→c1，i2 丢弃→c2
    expect(applied.report.neededHashes).not.toContain("H9");
    expect(applied.report.neededHashes).toContain("H3"); // 新增帧需要图片
  });

  it("自定义重命名名称；与现有帧重名时计划报错", () => {
    const plan1 = buildMergePlan(current, imported, "rename", {
      "jump.png": { action: "rename", newName: "jump_imported.png" }
    });
    const applied = applyMergePlan(current, imported, plan1);
    expect(applied.frames.map((f) => f.name)).toContain("jump_imported.png");
    expect(applied.report.renames).toEqual({ "jump.png": "jump_imported.png" });

    const plan2 = buildMergePlan(current, imported, "rename", {
      "jump.png": { action: "rename", newName: "run_01.png" }
    });
    expect(plan2.errors.length).toBeGreaterThan(0);
    expect(() => applyMergePlan(current, imported, plan2)).toThrow(/重名/);
  });

  it("自动重命名避开新增帧名", () => {
    // 导入方同时有冲突帧 jump.png 与新增帧 jump_2.png：自动重命名应得到 jump_3.png
    const cur = project("cur", [frame("c1", "jump.png", "H1")]);
    const imp = project("imp", [frame("i1", "jump.png", "H2"), frame("i2", "jump_2.png", "H3")]);
    const plan = buildMergePlan(cur, imp, "rename");
    const applied = applyMergePlan(cur, imp, plan);
    expect(applied.frames.map((f) => f.name)).toEqual(["jump.png", "jump_3.png", "jump_2.png"]);
  });
});
