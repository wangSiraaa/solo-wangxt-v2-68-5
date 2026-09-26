import type { PackLayout } from "./pack";
import type { Pixels, Settings } from "./types";
import type { StoredFrame, StoredProject, MergeRecord } from "./db";
import { commitMerge } from "./db";
import { buildAtlasJSON } from "./serialize";
import { hashBlobBytes } from "./hash";
import {
  applyMergePlan,
  buildMergePlan,
  validateProjectData,
  MergeError,
  type ConflictPolicy,
  type MergeProjectData,
  type MergeReport,
  type ResolutionOverride
} from "./merge";

/**
 * 合并执行器：把「纯函数合并计划」与「图片校验 / 图集重打包 / 原子提交」串起来。
 *
 * 原子性保证：
 * - 图片解码校验、引用校验、图集重打包全部在写库之前完成，任一失败即抛错，数据库零改动；
 * - 最后的写库是单个 IndexedDB 事务（见 db.commitMerge），事务内失败整体回滚。
 *
 * 图像操作通过 FrameDecoder / AtlasPacker 注入：浏览器用 canvas 实现，
 * Node 测试用 @napi-rs/canvas 实现，本模块不直接依赖 DOM。
 */

export interface FrameDecoder {
  /** 解码图片并读取像素；图片损坏时必须抛错 */
  decode(blob: Blob): Promise<{ width: number; height: number; pixels: Pixels }>;
}

export interface AtlasPacker {
  /** 裁切 + 打包 + 合成图集；放不下等失败时抛错 */
  pack(
    entries: Array<{ id: string; name: string; duration: number; blob: Blob }>,
    settings: Settings
  ): Promise<{ layout: PackLayout; atlasBlob: Blob }>;
}

/** 合并的导入方：工程元数据 + 帧图片（按内容摘要索引） */
export interface MergeSource {
  name: string;
  origin: "local" | "file";
  data: MergeProjectData;
  /** hash → PNG 数据 */
  blobs: Map<string, Blob>;
}

export interface PreparedMerge {
  after: StoredProject;
  record: MergeRecord;
  /** 需要写入 blobs 表的数据（导入帧图片 + 新图集） */
  newBlobs: Map<string, Blob>;
  report: MergeReport;
}

function toProjectData(p: StoredProject): MergeProjectData {
  return {
    name: p.name,
    frames: p.frames.map((f) => ({ ...f })),
    clips: p.clips.map((c) => ({ ...c, frameIds: [...c.frameIds] }))
  };
}

/** 预检导入工程：结构校验 + 逐帧解码校验（损坏图片在此暴露），返回错误列表 */
export async function preflightSource(source: MergeSource, decoder: FrameDecoder): Promise<string[]> {
  const errors: string[] = [];
  try {
    validateProjectData(source.data, "导入工程");
  } catch (e) {
    errors.push(e instanceof Error ? e.message : String(e));
    return errors; // 结构不合法时无法继续按帧检查
  }
  for (const f of source.data.frames) {
    const blob = source.blobs.get(f.hash);
    if (!blob) {
      errors.push(`帧「${f.name}」缺少图片数据（引用悬空）`);
      continue;
    }
    try {
      await decoder.decode(blob);
    } catch {
      errors.push(`帧「${f.name}」的图片已损坏，无法解码`);
    }
  }
  return errors;
}

/**
 * 准备合并（不触碰数据库）：校验 → 计划 → 应用 → 重打包 → 组装提交内容。
 * 任一环节失败抛 MergeError，此时数据库保持合并前状态。
 */
export async function prepareMerge(args: {
  before: StoredProject;
  beforeBlobs: Map<string, Blob>;
  source: MergeSource;
  policy: ConflictPolicy;
  overrides: Record<string, ResolutionOverride>;
  decoder: FrameDecoder;
  packer: AtlasPacker;
  recordId: string;
  now?: number;
}): Promise<PreparedMerge> {
  const { before, beforeBlobs, source, policy, overrides, decoder, packer, recordId } = args;
  const now = args.now ?? Date.now();

  // 1) 结构校验（重名、悬空引用）；当前工程允许为空（合并即全部新增）
  const currentData = toProjectData(before);
  validateProjectData(currentData, "当前工程", { allowEmpty: true });
  validateProjectData(source.data, "导入工程");

  // 2) 合并计划 + 应用（纯函数）
  const plan = buildMergePlan(currentData, source.data, policy, overrides);
  if (plan.errors.length > 0) throw new MergeError("name-conflict", plan.errors.join("；"));
  const applied = applyMergePlan(currentData, source.data, plan);

  // 3) 图片校验：导入方必须提供所有需要的帧图片且可解码
  const importedByHash = new Map(source.data.frames.map((f) => [f.hash, f]));
  const decodedSize = new Map<string, { width: number; height: number }>();
  for (const hash of applied.report.neededHashes) {
    const blob = source.blobs.get(hash);
    const frame = importedByHash.get(hash);
    if (!blob) {
      throw new MergeError("dangling-image", `导入工程缺少帧「${frame?.name ?? hash}」的图片数据（引用悬空）`);
    }
    try {
      const d = await decoder.decode(blob);
      decodedSize.set(hash, { width: d.width, height: d.height });
    } catch {
      throw new MergeError("corrupt-image", `帧「${frame?.name ?? hash}」的图片已损坏，无法解码`);
    }
  }
  // 当前工程的帧图片也必须齐备（重打包需要）
  for (const f of before.frames) {
    if (!beforeBlobs.has(f.hash)) {
      throw new MergeError("dangling-image", `当前工程缺少帧「${f.name}」的图片数据（引用悬空）`);
    }
  }

  // 以解码出的真实尺寸为准（手改过的 JSON 可能带有陈旧元数据）
  const mergedFrames: StoredFrame[] = applied.frames.map((f) => {
    const size = decodedSize.get(f.hash);
    return size ? { ...f, width: size.width, height: size.height } : { ...f };
  });

  // 4) 重打包图集（失败 → 抛错回滚）
  const blobByHash = new Map<string, Blob>([...beforeBlobs, ...source.blobs]);
  let packed: { layout: PackLayout; atlasBlob: Blob };
  try {
    packed = await packer.pack(
      mergedFrames.map((f) => ({
        id: f.id,
        name: f.name,
        duration: f.duration,
        blob: blobByHash.get(f.hash)!
      })),
      before.settings
    );
  } catch (e) {
    if (e instanceof MergeError) throw e;
    throw new MergeError("pack-failed", `图集重打包失败：${e instanceof Error ? e.message : String(e)}`);
  }

  // 5) 组装合并后的工程记录与合并记录
  const atlasHash = await hashBlobBytes(packed.atlasBlob);
  const json = buildAtlasJSON(packed.layout, {
    imageName: "atlas.png",
    trimmed: before.settings.trim,
    settings: before.settings,
    projectName: before.name,
    clips: applied.clips.map((c) => ({
      name: c.name,
      frames: c.frameIds.map((id) => mergedFrames.find((f) => f.id === id)?.name ?? id)
    }))
  });

  const after: StoredProject = {
    ...before,
    frames: mergedFrames,
    clips: applied.clips.map((c) => ({ ...c })),
    pack: { json, atlasHash },
    savedAt: now
  };

  const newBlobs = new Map<string, Blob>();
  for (const hash of applied.report.neededHashes) newBlobs.set(hash, source.blobs.get(hash)!);
  newBlobs.set(atlasHash, packed.atlasBlob);

  const record: MergeRecord = {
    id: recordId,
    projectId: before.id,
    ts: now,
    undone: false,
    undoneAt: null,
    imported: false,
    source: {
      name: source.name,
      origin: source.origin,
      frameCount: source.data.frames.length,
      clipCount: source.data.clips.length
    },
    decisions: applied.report.decisions,
    renames: applied.report.renames,
    summary: applied.report.summary,
    snapshot: before,
    addedBlobHashes: [] // 由 commitMerge 按实际写入填写
  };

  return { after, record, newBlobs, report: applied.report };
}

/** 准备并原子提交合并；返回落库后的合并记录（含实际新增的图片键） */
export async function executeMerge(args: {
  before: StoredProject;
  beforeBlobs: Map<string, Blob>;
  source: MergeSource;
  policy: ConflictPolicy;
  overrides: Record<string, ResolutionOverride>;
  decoder: FrameDecoder;
  packer: AtlasPacker;
  recordId: string;
  now?: number;
}): Promise<{ record: MergeRecord; after: StoredProject; report: MergeReport; newBlobs: Map<string, Blob> }> {
  const prepared = await prepareMerge(args);
  const record = await commitMerge(prepared.record, prepared.after, prepared.newBlobs);
  return { record, after: prepared.after, report: prepared.report, newBlobs: prepared.newBlobs };
}
