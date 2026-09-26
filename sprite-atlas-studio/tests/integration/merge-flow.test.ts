/**
 * 合并验收集成测试：在 fake-indexeddb 上跑完整合并流程（真实 PNG 编解码）。
 * 覆盖：去重合并引用、重命名保留两份、多处引用同步、批量+单项覆盖、
 * 损坏图片/悬空引用/打包失败完整回滚、刷新后撤销、导出再导入一致性。
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  IDBCursor,
  IDBCursorWithValue,
  IDBDatabase,
  IDBFactory,
  IDBIndex,
  IDBKeyRange,
  IDBObjectStore,
  IDBOpenDBRequest,
  IDBRequest,
  IDBTransaction
} from "fake-indexeddb";
import { openDB } from "idb";

// idb 包依赖这些全局类；indexedDB 本身每个用例换新实例以隔离数据
for (const [k, v] of Object.entries({
  IDBCursor,
  IDBCursorWithValue,
  IDBDatabase,
  IDBIndex,
  IDBKeyRange,
  IDBObjectStore,
  IDBOpenDBRequest,
  IDBRequest,
  IDBTransaction
})) {
  (globalThis as Record<string, unknown>)[k] = v;
}

import {
  _resetForTests,
  listMerges,
  loadBlobs,
  loadProjectRecord,
  saveImportedProject,
  undoMerge,
  type StoredProject
} from "../../src/lib/core/db";
import { executeMerge, preflightSource, type MergeSource } from "../../src/lib/core/mergeExec";
import { buildMergePreview, type MergeProjectData } from "../../src/lib/core/merge";
import { buildProjectExport, projectFromExport } from "../../src/lib/core/projectIO";
import { hashBlobBytes } from "../../src/lib/core/hash";
import { corruptBlob, makePng, nodeDecoder, nodePacker, nodeSlicer, seedProject } from "../helpers/nodeTools";

beforeEach(async () => {
  (globalThis as Record<string, unknown>).indexedDB = new IDBFactory();
  await _resetForTests();
});

// ---------- 辅助 ----------

/** 全量转储数据库状态（用于回滚相等性断言） */
async function dumpDb() {
  const d = await openDB("sprite-atlas-studio", 2);
  const names = d.objectStoreNames;
  const projects = names.contains("projects") ? await d.getAll("projects") : [];
  const merges = names.contains("merges") ? await d.getAll("merges") : [];
  const blobRecs = names.contains("blobs") ? await d.getAll("blobs") : [];
  const blobs: Record<string, string> = {};
  for (const b of blobRecs) {
    blobs[b.hash as string] = `${(b.blob as Blob).size}:${await hashBlobBytes(b.blob as Blob)}`;
  }
  d.close();
  return { projects, blobs, merges };
}

async function sourceOf(project: StoredProject): Promise<MergeSource> {
  const blobs = await loadBlobs(project.frames.map((f) => f.hash));
  return {
    name: project.name,
    origin: "local",
    data: {
      name: project.name,
      frames: project.frames.map((f) => ({ ...f })),
      clips: project.clips.map((c) => ({ ...c, frameIds: [...c.frameIds] }))
    },
    blobs
  };
}

function projectDataOf(p: StoredProject): MergeProjectData {
  return {
    name: p.name,
    frames: p.frames.map((f) => ({ ...f })),
    clips: p.clips.map((c) => ({ ...c, frameIds: [...c.frameIds] }))
  };
}

async function mergeNow(before: StoredProject, source: MergeSource, policy: "keep-current" | "use-imported" | "rename", overrides = {}) {
  return executeMerge({
    before,
    beforeBlobs: await loadBlobs(before.frames.map((f) => f.hash)),
    source,
    policy,
    overrides,
    decoder: nodeDecoder,
    packer: nodePacker,
    recordId: `rec_${Math.random().toString(36).slice(2, 8)}`
  });
}

// ---------- 验收：合并结果 ----------

describe("合并结果", () => {
  it("同名同内容只保留一份并合并引用（落库 + 重打包 + 记录）", async () => {
    const cur = await seedProject({
      name: "当前",
      frames: [
        { name: "run_01.png", blob: makePng(32, 32, 1) },
        { name: "jump_01.png", blob: makePng(32, 32, 2) }
      ],
      clips: [{ name: "run", frames: ["run_01.png"] }]
    });
    const imp = await seedProject({
      name: "导入",
      frames: [
        { name: "run_01.png", blob: makePng(32, 32, 1) }, // 与当前完全相同
        { name: "walk_01.png", blob: makePng(48, 48, 3) }
      ],
      clips: [
        { name: "run", frames: ["run_01.png"] },
        { name: "combo", frames: ["run_01.png", "walk_01.png"] }
      ]
    });

    const { record, after } = await mergeNow(cur, await sourceOf(imp), "rename");

    // 帧：相同帧去重，只保留当前一份（id 不变），新增帧追加到末尾
    expect(after.frames.map((f) => f.name)).toEqual(["run_01.png", "jump_01.png", "walk_01.png"]);
    expect(after.frames[0]!.id).toBe(cur.frames[0]!.id);
    expect(after.frames[0]!.hash).toBe(cur.frames[0]!.hash);

    // 片段：当前 run 保留；导入 run 重名自动改名 run_2；引用合并到现有帧
    expect(after.clips.map((c) => c.name)).toEqual(["run", "run_2", "combo"]);
    expect(after.clips[1]!.frameIds).toEqual([cur.frames[0]!.id]);
    expect(after.clips[2]!.frameIds).toEqual([cur.frames[0]!.id, after.frames[2]!.id]);

    // 落库内容与返回值一致
    const stored = await loadProjectRecord(cur.id);
    expect(stored!.frames).toEqual(after.frames);
    expect(stored!.clips).toEqual(after.clips);

    // 图片内容寻址：相同内容只有一份；本地合并时导入帧图片本就在库中，
    // 本次实际新增只有重打包的图集
    const dump = await dumpDb();
    expect(Object.keys(dump.blobs)).toHaveLength(4); // 3 帧 + 1 图集
    expect(record.addedBlobHashes).toEqual([after.pack!.atlasHash]);

    // 合并记录：来源摘要 + 快照
    const merges = await listMerges(cur.id);
    expect(merges).toHaveLength(1);
    expect(merges[0]!.source).toMatchObject({ name: "导入", origin: "local", frameCount: 2, clipCount: 2 });
    expect(merges[0]!.summary).toMatchObject({ identical: 1, conflicts: 0, added: 1, clipsAdded: 2 });
    expect(merges[0]!.snapshot!.frames).toEqual(cur.frames);
    expect(merges[0]!.undone).toBe(false);

    // 图集已重打包且图片可用
    expect(after.pack).not.toBeNull();
    expect(after.pack!.json.meta.frameOrder).toEqual(["run_01.png", "jump_01.png", "walk_01.png"]);
    const atlas = await loadBlobs([after.pack!.atlasHash]);
    expect(atlas.size).toBe(1);
    const atlasInfo = await nodeDecoder.decode(atlas.get(after.pack!.atlasHash)!);
    expect(atlasInfo.width).toBe(after.pack!.json.meta.size.w);
  });

  it("合并到空工程：全部作为新增", async () => {
    const cur = await seedProject({ name: "空工程", frames: [] });
    const imp = await seedProject({
      name: "导入",
      frames: [{ name: "a.png", blob: makePng(32, 32, 1) }],
      clips: [{ name: "x", frames: ["a.png"] }]
    });
    const { after } = await mergeNow(cur, await sourceOf(imp), "rename");
    expect(after.frames.map((f) => f.name)).toEqual(["a.png"]);
    expect(after.clips.map((c) => c.name)).toEqual(["x"]);
    expect(after.pack).not.toBeNull();
  });

  it("同名不同内容按重命名策略保留两份，导入工程内部多处引用同步更新", async () => {
    const cur = await seedProject({
      name: "当前",
      frames: [{ name: "run_01.png", blob: makePng(32, 32, 1) }],
      clips: [{ name: "idle", frames: ["run_01.png"] }]
    });
    const imp = await seedProject({
      name: "导入",
      frames: [{ name: "run_01.png", blob: makePng(32, 32, 7) }], // 同名不同内容
      clips: [
        { name: "x", frames: ["run_01.png"] },
        { name: "y", frames: ["run_01.png", "run_01.png"] } // 多处引用
      ]
    });

    const { record, after } = await mergeNow(cur, await sourceOf(imp), "rename");

    // 两份都保留
    expect(after.frames.map((f) => f.name)).toEqual(["run_01.png", "run_01_2.png"]);
    expect(after.frames[0]!.hash).toBe(cur.frames[0]!.hash); // 当前内容不动
    const renamed = after.frames[1]!;
    expect(renamed.hash).toBe(imp.frames[0]!.hash);

    // 导入工程内部多处引用全部指向重命名后的帧
    const clipX = after.clips.find((c) => c.name === "x")!;
    const clipY = after.clips.find((c) => c.name === "y")!;
    expect(clipX.frameIds).toEqual([renamed.id]);
    expect(clipY.frameIds).toEqual([renamed.id, renamed.id]);

    // 决策记录
    expect(record.decisions).toEqual({ "run_01.png": "rename" });
    expect(record.renames).toEqual({ "run_01.png": "run_01_2.png" });
  });

  it("批量规则应用后仍可单项覆盖", async () => {
    const cur = await seedProject({
      name: "当前",
      frames: [
        { name: "a.png", blob: makePng(32, 32, 1) },
        { name: "b.png", blob: makePng(32, 32, 2) }
      ]
    });
    const imp = await seedProject({
      name: "导入",
      frames: [
        { name: "a.png", blob: makePng(32, 32, 3) },
        { name: "b.png", blob: makePng(32, 32, 4) }
      ],
      clips: [{ name: "refs", frames: ["a.png", "b.png"] }]
    });

    // 批量：全部保留当前；单项覆盖：b.png 重命名
    const { record, after } = await mergeNow(cur, await sourceOf(imp), "keep-current", {
      "b.png": { action: "rename" }
    });

    expect(after.frames.map((f) => f.name)).toEqual(["a.png", "b.png", "b_2.png"]);
    // a.png 保留当前内容
    expect(after.frames[0]!.hash).toBe(cur.frames[0]!.hash);
    // 导入片段引用：a → 当前帧，b → 重命名新帧
    const refs = after.clips.find((c) => c.name === "refs")!;
    expect(refs.frameIds).toEqual([after.frames[0]!.id, after.frames[2]!.id]);
    expect(record.decisions).toEqual({ "a.png": "keep-current", "b.png": "rename" });
  });

  it("采用导入：当前帧内容被替换，当前片段引用保持有效", async () => {
    const cur = await seedProject({
      name: "当前",
      frames: [{ name: "a.png", blob: makePng(32, 32, 1) }],
      clips: [{ name: "x", frames: ["a.png"] }]
    });
    const imp = await seedProject({
      name: "导入",
      frames: [{ name: "a.png", blob: makePng(32, 32, 5) }]
    });

    const { record, after } = await mergeNow(cur, await sourceOf(imp), "use-imported");

    expect(after.frames).toHaveLength(1);
    expect(after.frames[0]!.id).toBe(cur.frames[0]!.id); // id 不变
    expect(after.frames[0]!.hash).toBe(imp.frames[0]!.hash); // 内容换成导入的
    expect(after.clips[0]!.frameIds).toEqual([cur.frames[0]!.id]); // 引用保持
    expect(record.decisions).toEqual({ "a.png": "use-imported" });
    // 新内容图片已入库
    const dump = await dumpDb();
    expect(Object.keys(dump.blobs)).toContain(imp.frames[0]!.hash);
  });
});

// ---------- 验收：失败回滚 ----------

describe("失败时完整回滚", () => {
  it("故意加入损坏图片：合并失败且不留下半合并数据", async () => {
    const cur = await seedProject({
      name: "当前",
      frames: [{ name: "a.png", blob: makePng(32, 32, 1) }],
      clips: [{ name: "x", frames: ["a.png"] }]
    });
    const imp = await seedProject({
      name: "导入",
      frames: [
        { name: "b.png", blob: makePng(32, 32, 2) },
        { name: "c.png", blob: makePng(32, 32, 3) }
      ],
      clips: [{ name: "y", frames: ["b.png", "c.png"] }]
    });

    // 故意损坏导入工程的一张图片
    const source = await sourceOf(imp);
    source.blobs.set(imp.frames[1]!.hash, corruptBlob());

    // 预检即可发现
    const errors = await preflightSource(source, nodeDecoder);
    expect(errors.some((e) => e.includes("损坏"))).toBe(true);

    const before = await dumpDb();
    await expect(mergeNow(cur, source, "rename")).rejects.toMatchObject({ code: "corrupt-image" });

    // 数据库保持合并前状态：工程、图片、合并记录零改动
    expect(await dumpDb()).toEqual(before);
    expect(await listMerges(cur.id)).toHaveLength(0);
  });

  it("引用悬空（片段指向不存在的帧）：拒绝合并且零改动", async () => {
    const cur = await seedProject({ name: "当前", frames: [{ name: "a.png", blob: makePng(32, 32, 1) }] });
    const imp = await seedProject({
      name: "导入",
      frames: [{ name: "b.png", blob: makePng(32, 32, 2) }],
      clips: [{ name: "y", frames: ["b.png"] }]
    });
    const source = await sourceOf(imp);
    source.data.clips[0]!.frameIds.push("ghost-frame-id"); // 悬空引用

    const before = await dumpDb();
    await expect(mergeNow(cur, source, "rename")).rejects.toMatchObject({ code: "dangling-reference" });
    expect(await dumpDb()).toEqual(before);
  });

  it("引用悬空（帧缺少图片数据）：拒绝合并且零改动", async () => {
    const cur = await seedProject({ name: "当前", frames: [{ name: "a.png", blob: makePng(32, 32, 1) }] });
    const imp = await seedProject({ name: "导入", frames: [{ name: "b.png", blob: makePng(32, 32, 2) }] });
    const source = await sourceOf(imp);
    source.blobs.delete(imp.frames[0]!.hash); // 图片数据缺失

    const before = await dumpDb();
    await expect(mergeNow(cur, source, "rename")).rejects.toMatchObject({ code: "dangling-image" });
    expect(await dumpDb()).toEqual(before);
  });

  it("打包失败（图集放不下）：拒绝合并且零改动", async () => {
    const cur = await seedProject({
      name: "当前",
      frames: [{ name: "a.png", blob: makePng(48, 48, 1) }],
      settings: { maxSize: 64, padding: 2, trim: false, pot: false }
    });
    const imp = await seedProject({
      name: "导入",
      frames: [{ name: "b.png", blob: makePng(48, 48, 2) }]
    });

    const before = await dumpDb();
    await expect(mergeNow(cur, await sourceOf(imp), "rename")).rejects.toMatchObject({ code: "pack-failed" });
    expect(await dumpDb()).toEqual(before);
    expect(await listMerges(cur.id)).toHaveLength(0);
  });
});

// ---------- 验收：撤销 ----------

describe("撤销合并", () => {
  it("刷新后仍可撤销最近合并：快照恢复、新增图片回收、记录标记", async () => {
    const cur = await seedProject({
      name: "当前",
      frames: [
        { name: "run_01.png", blob: makePng(32, 32, 1) },
        { name: "jump_01.png", blob: makePng(32, 32, 2) }
      ],
      clips: [{ name: "run", frames: ["run_01.png"] }]
    });
    const imp = await seedProject({
      name: "导入",
      frames: [
        { name: "run_01.png", blob: makePng(32, 32, 1) },
        { name: "walk_01.png", blob: makePng(48, 48, 3) }
      ],
      clips: [{ name: "combo", frames: ["run_01.png", "walk_01.png"] }]
    });
    const { after } = await mergeNow(cur, await sourceOf(imp), "rename");
    expect((await loadProjectRecord(cur.id))!.frames).toHaveLength(3);

    // 模拟刷新：关闭连接，用同一个数据库重新打开
    await _resetForTests();

    const rec = (await listMerges(cur.id))[0]!;
    const undone = await undoMerge(rec.id);
    expect(undone.undone).toBe(true);

    // 工程恢复到合并前快照
    const restored = await loadProjectRecord(cur.id);
    expect(restored!.frames).toEqual(cur.frames);
    expect(restored!.clips).toEqual(cur.clips);
    expect(restored!.pack).toBeNull();

    // 本次合并新增的图集被回收；原有图片保留（walk_01 仍被导入工程引用，GC 正确保留）
    const dump = await dumpDb();
    const remaining = Object.keys(dump.blobs).sort();
    expect(remaining).toEqual([cur.frames[0]!.hash, cur.frames[1]!.hash, imp.frames[1]!.hash].sort());
    expect(remaining).not.toContain(after.pack!.atlasHash);

    // 不能重复撤销
    await expect(undoMerge(rec.id)).rejects.toMatchObject({ code: "nothing-to-undo" });
  });

  it("文件来源合并：撤销后导入帧图片（对库而言是新增）被回收", async () => {
    const cur = await seedProject({ name: "当前", frames: [{ name: "a.png", blob: makePng(32, 32, 1) }] });
    // 导入工程不落库（模拟从 JSON 文件读入的合并来源）
    const { buildProjectData } = await import("../helpers/nodeTools");
    const fileProject = await buildProjectData({
      name: "文件工程",
      frames: [{ name: "b.png", blob: makePng(32, 32, 2) }]
    });
    const source: MergeSource = {
      name: fileProject.project.name,
      origin: "file",
      data: projectDataOf(fileProject.project),
      blobs: fileProject.blobs
    };

    const { record, after } = await mergeNow(cur, source, "rename");
    // 导入帧图片与图集都是本次新增
    expect(record.addedBlobHashes.sort()).toEqual(
      [fileProject.project.frames[0]!.hash, after.pack!.atlasHash].sort()
    );

    await undoMerge(record.id);
    const dump = await dumpDb();
    expect(Object.keys(dump.blobs)).toEqual([cur.frames[0]!.hash]);
  });

  it("只能撤销最近一次合并（栈语义）", async () => {    const cur = await seedProject({ name: "当前", frames: [{ name: "a.png", blob: makePng(32, 32, 1) }] });
    const imp1 = await seedProject({ name: "导入1", frames: [{ name: "b.png", blob: makePng(32, 32, 2) }] });
    const r1 = await mergeNow(cur, await sourceOf(imp1), "rename");
    const after1 = (await loadProjectRecord(cur.id))!;
    const imp2 = await seedProject({ name: "导入2", frames: [{ name: "c.png", blob: makePng(32, 32, 3) }] });
    await mergeNow(after1, await sourceOf(imp2), "rename");

    const merges = await listMerges(cur.id);
    expect(merges).toHaveLength(2);
    // 先撤销较早的一次 → 拒绝
    await expect(undoMerge(merges[0]!.id)).rejects.toMatchObject({ code: "not-latest" });
    // 撤销最近一次 → 成功，回到第一次合并后的状态
    await undoMerge(merges[1]!.id);
    expect((await loadProjectRecord(cur.id))!.frames.map((f) => f.name)).toEqual(["a.png", "b.png"]);
    // 再撤销第一次 → 成功，回到最初
    await undoMerge(merges[0]!.id);
    expect((await loadProjectRecord(cur.id))!.frames.map((f) => f.name)).toEqual(["a.png"]);
    void r1;
  });
});

// ---------- 验收：导出再导入一致性 ----------

describe("导出再导入", () => {
  it("帧顺序、图集和冲突决策一致；再合并时全部识别为相同帧", async () => {
    const cur = await seedProject({
      name: "当前",
      frames: [
        { name: "run_01.png", blob: makePng(32, 32, 1) },
        { name: "jump.png", blob: makePng(40, 40, 2) }
      ],
      clips: [{ name: "run", frames: ["run_01.png", "jump.png"] }]
    });
    const imp = await seedProject({
      name: "导入",
      frames: [
        { name: "run_01.png", blob: makePng(32, 32, 1) }, // 相同 → 去重
        { name: "jump.png", blob: makePng(40, 40, 9) }, // 冲突 → 重命名
        { name: "walk.png", blob: makePng(24, 24, 3) } // 新增
      ],
      clips: [{ name: "combo", frames: ["run_01.png", "jump.png", "walk.png"] }]
    });
    const { after } = await mergeNow(cur, await sourceOf(imp), "rename");
    const merges = await listMerges(cur.id);

    // 导出（内嵌图集，含片段与合并历史），模拟写盘再读回
    const atlasBlob = (await loadBlobs([after.pack!.atlasHash])).get(after.pack!.atlasHash)!;
    const atlasDataURL = `data:image/png;base64,${Buffer.from(await atlasBlob.arrayBuffer()).toString("base64")}`;
    const exported = buildProjectExport(after, { merges, atlasDataURL });
    const roundTripped = JSON.parse(JSON.stringify(exported)) as unknown;
    const imported = await projectFromExport(roundTripped, {
      slicer: nodeSlicer,
      decoder: nodeDecoder,
      id: "imported-copy"
    });

    // 帧顺序与内容摘要一致（像素级摘要对重新编码免疫）
    expect(imported.project.frames.map((f) => f.name)).toEqual(after.frames.map((f) => f.name));
    expect(imported.project.frames.map((f) => f.hash)).toEqual(after.frames.map((f) => f.hash));
    expect(imported.project.frames.map((f) => f.duration)).toEqual(after.frames.map((f) => f.duration));

    // 图集布局一致
    expect(imported.project.pack!.json.meta.frameOrder).toEqual(after.pack!.json.meta.frameOrder);
    expect(imported.project.pack!.json.meta.size).toEqual(after.pack!.json.meta.size);
    for (const f of after.frames) {
      expect(imported.project.pack!.json.frames[f.name]!.frame).toEqual(after.pack!.json.frames[f.name]!.frame);
    }

    // 片段一致（按帧名比较）
    expect(imported.project.clips.map((c) => c.name)).toEqual(after.clips.map((c) => c.name));
    for (const [i, c] of after.clips.entries()) {
      const names = c.frameIds.map((id) => after.frames.find((f) => f.id === id)!.name);
      const inames = imported.project.clips[i]!.frameIds.map(
        (id) => imported.project.frames.find((f) => f.id === id)!.name
      );
      expect(inames).toEqual(names);
    }

    // 冲突决策一致
    expect(imported.merges.map((m) => m.decisions)).toEqual(merges.map((m) => m.decisions));
    expect(imported.merges.map((m) => m.renames)).toEqual(merges.map((m) => m.renames));
    expect(imported.merges.map((m) => m.summary)).toEqual(merges.map((m) => m.summary));
    expect(imported.merges[0]!.imported).toBe(true); // 导入的历史不可撤销

    // 落库后再读出，保持一致
    await saveImportedProject(imported.project, imported.blobs, imported.merges);
    const loaded = await loadProjectRecord("imported-copy");
    expect(loaded!.frames.map((f) => f.name)).toEqual(after.frames.map((f) => f.name));
    expect((await listMerges("imported-copy")).map((m) => m.decisions)).toEqual(merges.map((m) => m.decisions));

    // 把往返后的工程再合并回当前工程 → 全部识别为相同帧（去重），无冲突无新增
    const src: MergeSource = {
      name: imported.project.name,
      origin: "file",
      data: projectDataOf(imported.project),
      blobs: imported.blobs
    };
    const preview = buildMergePreview(projectDataOf(after), src.data);
    expect(preview.identical).toHaveLength(after.frames.length);
    expect(preview.conflicts).toHaveLength(0);
    expect(preview.additions).toHaveLength(0);
  });
});
