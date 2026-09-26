/**
 * 合并引擎（纯函数，无 DOM / IndexedDB 依赖，可直接在 Node 中测试）。
 *
 * 流程：
 *   1. validateProjectData  校验工程结构（重名、悬空引用）
 *   2. buildMergePreview    生成预览：相同帧（内容摘要一致）、同名冲突、新增帧
 *   3. buildMergePlan       按批量策略 + 单项覆盖生成每个导入帧的处置动作
 *   4. applyMergePlan       应用计划，产出合并后的帧列表与片段（引用同步更新）
 */

export type ConflictPolicy = "keep-current" | "use-imported" | "rename";

export interface ResolutionOverride {
  action: ConflictPolicy;
  /** action 为 rename 时的自定义新名称（留空则自动生成） */
  newName?: string;
}

export type MergeErrorCode =
  | "invalid-project"
  | "dangling-reference"
  | "dangling-image"
  | "corrupt-image"
  | "pack-failed"
  | "name-conflict"
  | "nothing-to-undo"
  | "not-latest";

export class MergeError extends Error {
  readonly code: MergeErrorCode;
  constructor(code: MergeErrorCode, message: string) {
    super(message);
    this.name = "MergeError";
    this.code = code;
  }
}

/** 参与合并的帧元数据（图片来自内容寻址存储，此处不含二进制） */
export interface MergeFrameMeta {
  id: string;
  name: string;
  hash: string;
  duration: number;
  width: number;
  height: number;
}

export interface MergeClip {
  id: string;
  name: string;
  frameIds: string[];
}

export interface MergeProjectData {
  name: string;
  frames: MergeFrameMeta[];
  clips: MergeClip[];
}

// ---------- 结构校验 ----------

/** 校验工程结构：帧名/片段名唯一、片段引用不悬空。不合法时抛出 MergeError */
export function validateProjectData(p: MergeProjectData, label: string, opts: { allowEmpty?: boolean } = {}): void {
  if (p.frames.length === 0 && !opts.allowEmpty) {
    throw new MergeError("invalid-project", `${label}没有任何帧`);
  }
  const frameNames = new Set<string>();
  const frameIds = new Set<string>();
  for (const f of p.frames) {
    if (frameNames.has(f.name)) throw new MergeError("invalid-project", `${label}存在重名帧「${f.name}」`);
    if (frameIds.has(f.id)) throw new MergeError("invalid-project", `${label}存在重复的帧 id`);
    frameNames.add(f.name);
    frameIds.add(f.id);
  }
  const clipNames = new Set<string>();
  for (const c of p.clips) {
    if (clipNames.has(c.name)) throw new MergeError("invalid-project", `${label}存在重名片段「${c.name}」`);
    clipNames.add(c.name);
    for (const fid of c.frameIds) {
      if (!frameIds.has(fid)) {
        throw new MergeError("dangling-reference", `${label}的片段「${c.name}」引用了不存在的帧`);
      }
    }
  }
}

// ---------- 命名工具 ----------

/** 生成不与 taken 冲突的名称：name.png → name_2.png → name_3.png … */
export function uniqueName(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : "";
  let i = 2;
  while (taken.has(`${stem}_${i}${ext}`)) i++;
  return `${stem}_${i}${ext}`;
}

// ---------- 预览 ----------

export interface IdenticalEntry {
  name: string;
  hash: string;
  currentFrameId: string;
  importedFrameId: string;
  /** 导入工程中引用该帧的片段名 */
  importedReferencedBy: string[];
}

export interface ConflictEntry {
  name: string;
  currentFrameId: string;
  currentHash: string;
  importedFrameId: string;
  importedHash: string;
  /** 当前工程中引用该帧的片段名 */
  currentReferencedBy: string[];
  /** 导入工程中引用该帧的片段名 */
  importedReferencedBy: string[];
}

export interface AdditionEntry {
  name: string;
  hash: string;
  importedFrameId: string;
  importedReferencedBy: string[];
  /** 内容相同但名称不同的当前帧名（仅提示，不影响合并） */
  duplicateOf: string | null;
}

export interface MergePreview {
  /** 同名同内容：自动去重，只保留当前一份，导入方引用合并过来 */
  identical: IdenticalEntry[];
  /** 同名不同内容：需要用户决策 */
  conflicts: ConflictEntry[];
  /** 导入方独有的新帧 */
  additions: AdditionEntry[];
}

function referencedBy(clips: MergeClip[], frameId: string): string[] {
  return clips.filter((c) => c.frameIds.includes(frameId)).map((c) => c.name);
}

/** 生成合并预览（静态部分；片段引用影响随决议变化，见 applyMergePlan 的报告） */
export function buildMergePreview(current: MergeProjectData, imported: MergeProjectData): MergePreview {
  const currentByName = new Map(current.frames.map((f) => [f.name, f]));
  const currentByHash = new Map(current.frames.map((f) => [f.hash, f]));

  const identical: IdenticalEntry[] = [];
  const conflicts: ConflictEntry[] = [];
  const additions: AdditionEntry[] = [];

  for (const imp of imported.frames) {
    const cur = currentByName.get(imp.name);
    if (cur && cur.hash === imp.hash) {
      identical.push({
        name: imp.name,
        hash: imp.hash,
        currentFrameId: cur.id,
        importedFrameId: imp.id,
        importedReferencedBy: referencedBy(imported.clips, imp.id)
      });
    } else if (cur) {
      conflicts.push({
        name: imp.name,
        currentFrameId: cur.id,
        currentHash: cur.hash,
        importedFrameId: imp.id,
        importedHash: imp.hash,
        currentReferencedBy: referencedBy(current.clips, cur.id),
        importedReferencedBy: referencedBy(imported.clips, imp.id)
      });
    } else {
      const dup = currentByHash.get(imp.hash);
      additions.push({
        name: imp.name,
        hash: imp.hash,
        importedFrameId: imp.id,
        importedReferencedBy: referencedBy(imported.clips, imp.id),
        duplicateOf: dup ? dup.name : null
      });
    }
  }
  return { identical, conflicts, additions };
}

// ---------- 决议 → 计划 ----------

export type FrameAction =
  | { type: "dedup"; targetId: string }
  | { type: "drop"; targetId: string }
  | { type: "replace"; targetId: string }
  | { type: "add"; newId: string; newName: string };

export interface MergePlan {
  /** importedFrameId → 处置动作 */
  actions: Map<string, FrameAction>;
  /** 自定义重命名冲突等可修复错误（非空时不应继续合并） */
  errors: string[];
}

let planSeq = 0;
function freshId(): string {
  return `m${Date.now().toString(36)}_${(planSeq++).toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

/**
 * 按批量策略 + 单项覆盖生成合并计划。
 * @param overrides 以冲突帧名为键的单项覆盖（批量规则之外的例外）
 */
export function buildMergePlan(
  current: MergeProjectData,
  imported: MergeProjectData,
  policy: ConflictPolicy,
  overrides: Record<string, ResolutionOverride> = {}
): MergePlan {
  const preview = buildMergePreview(current, imported);
  const actions = new Map<string, FrameAction>();
  const errors: string[] = [];

  const currentIds = new Set(current.frames.map((f) => f.id));
  const assignedIds = new Set<string>();
  /** 优先沿用导入帧 id；与当前工程或已分配 id 冲突时分配新 id */
  const freeId = (preferred: string): string => {
    if (!currentIds.has(preferred) && !assignedIds.has(preferred)) {
      assignedIds.add(preferred);
      return preferred;
    }
    const id = freshId();
    assignedIds.add(id);
    return id;
  };

  for (const e of preview.identical) {
    actions.set(e.importedFrameId, { type: "dedup", targetId: e.currentFrameId });
  }

  // 新名称占用集合：当前帧名 ∪ 导入新增帧名（新增帧名保留不变，重命名须避开）
  const takenNames = new Set<string>([
    ...current.frames.map((f) => f.name),
    ...preview.additions.map((a) => a.name)
  ]);

  for (const c of preview.conflicts) {
    const override = overrides[c.name];
    const action = override?.action ?? policy;
    if (action === "keep-current") {
      actions.set(c.importedFrameId, { type: "drop", targetId: c.currentFrameId });
    } else if (action === "use-imported") {
      actions.set(c.importedFrameId, { type: "replace", targetId: c.currentFrameId });
    } else {
      const custom = override?.newName?.trim();
      const newName = custom || uniqueName(c.name, takenNames);
      if (takenNames.has(newName)) {
        errors.push(`新名称「${newName}」与现有帧重名，请换一个名称`);
        continue;
      }
      takenNames.add(newName);
      actions.set(c.importedFrameId, { type: "add", newId: freeId(c.importedFrameId), newName });
    }
  }

  for (const a of preview.additions) {
    actions.set(a.importedFrameId, { type: "add", newId: freeId(a.importedFrameId), newName: a.name });
  }

  return { actions, errors };
}

// ---------- 应用计划 ----------

export interface RefImpact {
  importedFrameId: string;
  frameName: string;
  effect: "dedup" | "drop-to-current" | "replace" | "add" | "rename";
  /** 合并后该引用指向的帧名 */
  finalFrameName: string;
}

export interface ClipResult {
  importedClipId: string;
  importedName: string;
  finalName: string;
  renamed: boolean;
  references: RefImpact[];
}

export interface MergeReport {
  /** 冲突决策（以冲突帧名为键） */
  decisions: Record<string, ConflictPolicy>;
  /** 重命名映射：导入帧名 → 最终帧名 */
  renames: Record<string, string>;
  addedFrameIds: string[];
  replacedFrameIds: string[];
  /** 被去重/丢弃的导入帧 id */
  foldedFrameIds: string[];
  clipResults: ClipResult[];
  /** 当前工程中因「采用导入」而内容将被替换的引用影响 */
  currentClipImpacts: Array<{ clipName: string; frameName: string }>;
  /** 合并后需要导入方提供图片数据的帧内容摘要 */
  neededHashes: string[];
  summary: { identical: number; conflicts: number; added: number; clipsAdded: number; clipsRenamed: number };
}

export interface AppliedMerge {
  frames: MergeFrameMeta[];
  clips: MergeClip[];
  report: MergeReport;
}

/** 应用合并计划：产出合并后的帧列表与片段（纯函数，不修改入参） */
export function applyMergePlan(
  current: MergeProjectData,
  imported: MergeProjectData,
  plan: MergePlan
): AppliedMerge {
  if (plan.errors.length > 0) {
    throw new MergeError("name-conflict", plan.errors.join("；"));
  }

  const frames: MergeFrameMeta[] = current.frames.map((f) => ({ ...f }));
  const frameIndexById = new Map(frames.map((f, i) => [f.id, i]));
  const importedById = new Map(imported.frames.map((f) => [f.id, f]));

  const decisions: Record<string, ConflictPolicy> = {};
  const renames: Record<string, string> = {};
  const addedFrameIds: string[] = [];
  const replacedFrameIds: string[] = [];
  const foldedFrameIds: string[] = [];
  const neededHashes = new Set<string>();
  /** importedFrameId → 合并后的帧 id */
  const idMap = new Map<string, string>();

  const preview = buildMergePreview(current, imported);

  // 与 buildMergePlan 相同的顺序遍历，保证帧追加顺序确定：当前帧原位保留，导入帧按导入顺序追加
  for (const imp of imported.frames) {
    const action = plan.actions.get(imp.id);
    if (!action) throw new MergeError("invalid-project", `缺少对导入帧「${imp.name}」的处置动作`);
    switch (action.type) {
      case "dedup":
        idMap.set(imp.id, action.targetId);
        foldedFrameIds.push(imp.id);
        break;
      case "drop":
        idMap.set(imp.id, action.targetId);
        foldedFrameIds.push(imp.id);
        decisions[imp.name] = "keep-current";
        break;
      case "replace": {
        const idx = frameIndexById.get(action.targetId);
        if (idx === undefined) throw new MergeError("invalid-project", `替换目标帧不存在：${imp.name}`);
        frames[idx] = { ...imp, id: action.targetId, name: frames[idx]!.name };
        idMap.set(imp.id, action.targetId);
        replacedFrameIds.push(action.targetId);
        neededHashes.add(imp.hash);
        decisions[imp.name] = "use-imported";
        break;
      }
      case "add": {
        frames.push({ ...imp, id: action.newId, name: action.newName });
        idMap.set(imp.id, action.newId);
        addedFrameIds.push(action.newId);
        neededHashes.add(imp.hash);
        if (action.newName !== imp.name) {
          renames[imp.name] = action.newName;
          decisions[imp.name] = "rename";
        }
        break;
      }
    }
  }

  // 片段：当前片段保留；导入片段重映射引用后追加，重名自动改名
  const clips: MergeClip[] = current.clips.map((c) => ({ ...c, frameIds: [...c.frameIds] }));
  const takenClipNames = new Set(current.clips.map((c) => c.name));
  const clipResults: ClipResult[] = [];

  for (const clip of imported.clips) {
    const references: RefImpact[] = [];
    const frameIds: string[] = [];
    for (const fid of clip.frameIds) {
      const target = idMap.get(fid);
      const impFrame = importedById.get(fid);
      if (!target || !impFrame) {
        throw new MergeError("dangling-reference", `导入片段「${clip.name}」引用了不存在的帧`);
      }
      const action = plan.actions.get(fid)!;
      const finalFrame = frames.find((f) => f.id === target)!;
      let effect: RefImpact["effect"];
      if (action.type === "dedup") effect = "dedup";
      else if (action.type === "drop") effect = "drop-to-current";
      else if (action.type === "replace") effect = "replace";
      else effect = action.newName === impFrame.name ? "add" : "rename";
      references.push({ importedFrameId: fid, frameName: impFrame.name, effect, finalFrameName: finalFrame.name });
      frameIds.push(target);
    }
    const finalName = uniqueName(clip.name, takenClipNames);
    takenClipNames.add(finalName);
    // 片段 id 与当前工程冲突时分配新 id（同一工程反复合并/自导入时可能发生）
    const clipId = current.clips.some((c) => c.id === clip.id) ? freshId() : clip.id;
    clips.push({ id: clipId, name: finalName, frameIds });
    clipResults.push({
      importedClipId: clip.id,
      importedName: clip.name,
      finalName,
      renamed: finalName !== clip.name,
      references
    });
  }

  // 当前片段受「采用导入」影响的引用
  const currentClipImpacts: Array<{ clipName: string; frameName: string }> = [];
  for (const c of preview.conflicts) {
    const action = plan.actions.get(c.importedFrameId);
    if (action?.type === "replace") {
      for (const clipName of c.currentReferencedBy) {
        currentClipImpacts.push({ clipName, frameName: c.name });
      }
    }
  }

  const renamedClips = clipResults.filter((c) => c.renamed).length;
  return {
    frames,
    clips,
    report: {
      decisions,
      renames,
      addedFrameIds,
      replacedFrameIds,
      foldedFrameIds,
      clipResults,
      currentClipImpacts,
      neededHashes: [...neededHashes],
      summary: {
        identical: preview.identical.length,
        conflicts: preview.conflicts.length,
        added: addedFrameIds.length,
        clipsAdded: clipResults.length,
        clipsRenamed: renamedClips
      }
    }
  };
}
