import { blobToImage, ctx2d, dataURLToBlob, makeCanvas } from "./image";
import { parseAtlasJSON } from "./serialize";
import type { Settings } from "./types";

/** 两个本地精灵工程的纯浏览器合并：摘要、预览决策、最终计划 */

export type ConflictDecision = "keep-current" | "adopt-import" | "rename-import";

export interface MergeProjectFrame {
  id: string;
  name: string;
  duration: number;
  width: number;
  height: number;
  blob: Blob;
  digest: string;
  url?: string;
}

export interface MergeProject {
  settings: Settings;
  frames: MergeProjectFrame[];
  sourceHash: string;
  imageName?: string;
}

export interface ConflictItem {
  name: string;
  current: MergeProjectFrame;
  imported: MergeProjectFrame;
  decision: ConflictDecision;
  defaultNewName: string;
  newName: string;
  currentReferenceCount: number;
  importedReferenceCount: number;
  importedAliases: string[];
}

export interface IdenticalItem {
  /** 合并后保留的名称（优先当前工程名称） */
  name: string;
  digest: string;
  aliases: string[];
  currentReferenceCount: number;
  importedReferenceCount: number;
  importedAliases: string[];
  currentDuration: number;
  importedDuration: number;
}

export interface ImportedOnlyItem {
  name: string;
  digest: string;
  width: number;
  height: number;
  duration: number;
  referenceCount: number;
  aliases?: string[];
  url?: string;
}

export interface ReferenceImpact {
  source: "current" | "imported";
  location: "图集帧表" | "播放顺序" | "同名内容引用";
  fromName: string;
  toName: string;
  occurrence?: number;
  reason: string;
}

export interface MergeDecisionRecord {
  name: string;
  decision: ConflictDecision;
  newName?: string;
}

export interface MergeSummary {
  id: string;
  createdAt: string;
  currentSourceHash: string;
  importedSourceHash: string;
  currentFrameCount: number;
  importedFrameCount: number;
  finalFrameCount: number;
  finalSequenceLength: number;
  identicalCount: number;
  conflictCount: number;
  addedCount: number;
  deduplicatedReferences: number;
  decisions: MergeDecisionRecord[];
  frameOrder: string[];
  undoable?: boolean;
}

export interface MergePreview {
  current: MergeProject;
  imported: MergeProject;
  identical: IdenticalItem[];
  conflicts: ConflictItem[];
  importedOnly: ImportedOnlyItem[];
  referenceImpacts: ReferenceImpact[];
  stats: {
    currentAssets: number;
    importedAssets: number;
    finalAssets: number;
    finalSequenceLength: number;
  };
}

export interface FinalAsset {
  name: string;
  digest: string;
  duration: number;
  width: number;
  height: number;
  blob: Blob;
  source: "current" | "imported";
}

export interface MergePlan {
  assets: FinalAsset[];
  /** 播放顺序，允许同一资源出现多次以保留多处引用 */
  order: Array<{ name: string; duration: number }>;
  settings: Settings;
  summary: Omit<MergeSummary, "id" | "createdAt">;
}

const SUBTLE_PREFIX = "sha256:";
const FALLBACK_PREFIX = "fnv1a:";

function bytesToHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** 基于解码后的 RGBA 像素生成摘要；同名文件只要渲染内容一致即可识别。 */
export async function digestImageBlob(blob: Blob): Promise<string> {
  const img = await blobToImage(blob);
  if (!img.naturalWidth || !img.naturalHeight) throw new Error("图片尺寸无效");
  const canvas = makeCanvas(img.naturalWidth, img.naturalHeight);
  const ctx = ctx2d(canvas);
  ctx.drawImage(img, 0, 0);
  const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;

  if (globalThis.crypto?.subtle) {
    const hash = await crypto.subtle.digest("SHA-256", pixels);
    return SUBTLE_PREFIX + bytesToHex(hash);
  }

  // 极少数非安全上下文没有 crypto.subtle 时，仍给出本地内容摘要。
  let h1 = 0x811c9dc5;
  let h2 = 0x811c9dc5;
  for (let i = 0; i < pixels.length; i++) {
    const value = pixels[i] ?? 0;
    h1 = Math.imul(h1 ^ value, 0x01000193) >>> 0;
    if (i % 2 === 0) h2 = Math.imul(h2 ^ value, 0x01000193) >>> 0;
  }
  return `${FALLBACK_PREFIX}${(h1 + h2).toString(16)}${pixels.length.toString(16)}`;
}

function stableSourceHash(frames: Array<{ name: string; digest: string; duration: number }>): string {
  let h = 0x811c9dc5;
  const text = frames
    .map((f) => `${f.name}|${f.digest}|${f.duration}`)
    .join("\n");
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0;
  return h.toString(16).padStart(8, "0");
}

export async function projectFromFrames(
  frames: Array<{ name: string; duration: number; width: number; height: number; blob: Blob; url?: string }>,
  settings: Settings
): Promise<MergeProject> {
  const out: MergeProjectFrame[] = [];
  for (const f of frames) {
    const digest = await digestImageBlob(f.blob);
    out.push({
      id: `${f.name}#${out.filter((x) => x.name === f.name).length}`,
      name: f.name,
      duration: f.duration,
      width: f.width,
      height: f.height,
      blob: f.blob,
      digest,
      ...(f.url ? { url: f.url } : {})
    });
  }
  return { settings, frames: out, sourceHash: stableSourceHash(out) };
}

/** 读取另一个本地工程导出的 JSON，并立即解码/摘要所有切出的图片，提前发现损坏。 */
export async function loadImportedProject(jsonFile: File): Promise<MergeProject> {
  let parsed: ReturnType<typeof parseAtlasJSON>;
  try {
    parsed = parseAtlasJSON(JSON.parse(await jsonFile.text()));
  } catch (e) {
    throw new Error(`导入工程无法解析：${e instanceof Error ? e.message : String(e)}`);
  }

  const atlasBlob = parsed.atlasDataURL
    ? dataURLToBlob(parsed.atlasDataURL)
    : null;
  if (!atlasBlob) throw new Error("导入工程必须使用内嵌图集的 atlas.json");

  const atlasImg = await blobToImage(atlasBlob).catch((e) => {
    throw new Error(`导入工程图片损坏：图集（${e instanceof Error ? e.message : String(e)}）`);
  });
  if (!atlasImg.naturalWidth || !atlasImg.naturalHeight) {
    throw new Error("导入工程图片损坏：图集尺寸无效");
  }
  const frames: MergeProjectFrame[] = [];
  const occurrenceByName = new Map<string, number>();

  for (let index = 0; index < parsed.frames.length; index++) {
    const f = parsed.frames[index]!;
    const full = makeCanvas(f.sourceSize.w, f.sourceSize.h);
    ctx2d(full).drawImage(
      atlasImg,
      f.frame.x,
      f.frame.y,
      f.frame.w,
      f.frame.h,
      f.spriteSourceSize.x,
      f.spriteSourceSize.y,
      f.frame.w,
      f.frame.h
    );
    const blob: Blob = await new Promise((resolve, reject) => {
      full.toBlob((b) => (b ? resolve(b) : reject(new Error("切出导入帧失败"))), "image/png");
    });

    try {
      const digest = await digestImageBlob(blob);
      const occurrence = occurrenceByName.get(f.name) ?? 0;
      occurrenceByName.set(f.name, occurrence + 1);
      frames.push({
        id: f.id ?? `${f.name}#${occurrence}`,
        name: f.name,
        duration: f.duration,
        width: f.sourceSize.w,
        height: f.sourceSize.h,
        blob,
        digest
      });
    } catch (e) {
      throw new Error(`导入工程图片损坏：${f.name}（${e instanceof Error ? e.message : String(e)}）`);
    }
  }

  return {
    settings: parsed.settings,
    frames,
    sourceHash: stableSourceHash(frames),
    imageName: parsed.imageName
  };
}

function countNames(frames: MergeProjectFrame[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const f of frames) m.set(f.name, (m.get(f.name) ?? 0) + 1);
  return m;
}

function uniqueName(base: string, used: Set<string>): string {
  if (!used.has(base)) return base;
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : "";
  let i = 2;
  while (used.has(`${stem}_imported_${i}${ext}`)) i++;
  return `${stem}_imported_${i}${ext}`;
}

export function defaultImportName(name: string, used: Set<string>): string {
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  const base = `${stem}_imported${ext}`;
  if (!used.has(base)) return base;
  return uniqueName(name, used);
}

function assertInternalConsistency(project: MergeProject, label: string): void {
  const byName = new Map<string, string>();
  for (const f of project.frames) {
    const old = byName.get(f.name);
    if (old && old !== f.digest) {
      throw new Error(`${label}内部引用不一致：名称“${f.name}”对应了多种图片内容`);
    }
    byName.set(f.name, f.digest);
  }
}

export async function createMergePreview(
  currentData: Parameters<typeof projectFromFrames>[0],
  currentSettings: Settings,
  imported: MergeProject
): Promise<MergePreview> {
  const current = await projectFromFrames(currentData, currentSettings);
  assertInternalConsistency(current, "当前工程");
  assertInternalConsistency(imported, "导入工程");

  const currentCounts = countNames(current.frames);
  const importedCounts = countNames(imported.frames);
  const currentByName = new Map<string, MergeProjectFrame>();
  const importedByName = new Map<string, MergeProjectFrame>();
  for (const f of current.frames) if (!currentByName.has(f.name)) currentByName.set(f.name, f);
  for (const f of imported.frames) if (!importedByName.has(f.name)) importedByName.set(f.name, f);

  const usedNames = new Set(current.frames.map((f) => f.name));
  const conflicts: ConflictItem[] = [];
  const identicalKeys = new Map<string, IdenticalItem>();

  for (const [name, imp] of importedByName) {
    const cur = currentByName.get(name);
    if (!cur) continue;
    if (cur.digest === imp.digest) {
      identicalKeys.set(name, {
        name,
        digest: cur.digest,
        aliases: [],
        currentReferenceCount: currentCounts.get(name) ?? 0,
        importedReferenceCount: importedCounts.get(name) ?? 0,
        importedAliases: [],
        currentDuration: cur.duration,
        importedDuration: imp.duration
      });
    } else {
      const newName = defaultImportName(name, usedNames);
      usedNames.add(newName);
      conflicts.push({
        name,
        current: cur,
        imported: imp,
        decision: "rename-import",
        defaultNewName: newName,
        newName,
        currentReferenceCount: currentCounts.get(name) ?? 0,
        importedReferenceCount: importedCounts.get(name) ?? 0,
        importedAliases: []
      });
    }
  }

  // 同内容但名称不同：也只保留一份，当前工程名称作为规范名。
  const currentByDigest = new Map<string, MergeProjectFrame[]>();
  for (const f of current.frames) {
    const list = currentByDigest.get(f.digest) ?? [];
    list.push(f);
    currentByDigest.set(f.digest, list);
  }
  for (const [name, imp] of importedByName) {
    if (currentByName.has(name)) continue;
    const same = currentByDigest.get(imp.digest);
    if (!same || same.length === 0) continue;
    const canonical = same[0]!.name;
    const item =
      identicalKeys.get(canonical) ??
      ({
        name: canonical,
        digest: imp.digest,
        aliases: [],
        currentReferenceCount: currentCounts.get(canonical) ?? 0,
        importedReferenceCount: 0,
        importedAliases: [],
        currentDuration: same[0]!.duration,
        importedDuration: imp.duration
      } satisfies IdenticalItem);
    if (!item.aliases.includes(name)) item.aliases.push(name);
    item.importedReferenceCount += importedCounts.get(name) ?? 0;
    identicalKeys.set(canonical, item);
  }

  // 导入工程内部的同内容别名也只保留一份，全部引用指向首个名称。
  const importedDigestGroups = new Map<string, MergeProjectFrame[]>();
  for (const f of imported.frames) {
    if (currentByDigest.has(f.digest)) continue;
    const list = importedDigestGroups.get(f.digest) ?? [];
    list.push(f);
    importedDigestGroups.set(f.digest, list);
  }

  const importedOnly: ImportedOnlyItem[] = [];
  for (const [digest, members] of importedDigestGroups) {
    const first = members.find((m) => importedByName.get(m.name) === m) ?? members[0]!;
    const aliasSet = [...new Set(members.map((m) => m.name).filter((n) => n !== first.name))];
    const conflict = conflicts.find((c) => c.imported.digest === digest);
    if (conflict) {
      conflict.importedReferenceCount = members.length;
      conflict.importedAliases = aliasSet.filter((name) => name !== conflict.name);
      continue;
    }
    importedOnly.push({
      name: first.name,
      digest,
      width: first.width,
      height: first.height,
      duration: first.duration,
      referenceCount: members.length,
      ...(aliasSet.length ? { aliases: aliasSet } : {})
    });
  }

  const referenceImpacts: ReferenceImpact[] = [];
  for (const item of identicalKeys.values()) {
    const importedNames = [item.name, ...item.aliases];
    for (const n of importedNames) {
      const count = importedCounts.get(n) ?? 0;
      if (n !== item.name) {
        referenceImpacts.push({
          source: "imported",
          location: "图集帧表",
          fromName: n,
          toName: item.name,
          reason: "内容摘要相同，合并为同一帧"
        });
      }
      for (let i = 0; i < count; i++) {
        referenceImpacts.push({
          source: "imported",
          location: "播放顺序",
          fromName: n,
          toName: item.name,
          occurrence: i + 1,
          reason: n === item.name ? "同名同内容，引用合并" : "同内容别名，引用改指向保留帧"
        });
      }
    }
  }
  for (const c of conflicts) {
    for (const n of [c.name, ...c.importedAliases]) {
      const count = importedCounts.get(n) ?? 0;
      referenceImpacts.push({
        source: "imported",
        location: "图集帧表",
        fromName: n,
        toName: n === c.name ? c.name : `${c.name}（待决策）`,
        reason: n === c.name ? "同名不同内容，等待逐项决策" : "与冲突帧内容相同，将随决策同步改名"
      });
      for (let i = 0; i < count; i++) {
        referenceImpacts.push({
          source: "imported",
          location: "播放顺序",
          fromName: n,
          toName: n === c.name ? c.name : `${c.name}（待决策）`,
          occurrence: i + 1,
          reason: n === c.name ? "同名不同内容，等待逐项决策" : "与冲突帧内容相同，将随决策同步改名"
        });
      }
    }
  }

  const identical = [...identicalKeys.values()].sort((a, b) => a.name.localeCompare(b.name));
  const finalAssets =
    current.frames.filter((f, i, arr) => arr.findIndex((x) => x.name === f.name) === i).length +
    importedOnly.length +
    conflicts.length;

  return {
    current,
    imported,
    identical,
    conflicts,
    importedOnly,
    referenceImpacts,
    stats: {
      currentAssets: currentByName.size,
      importedAssets: importedByName.size,
      finalAssets,
      finalSequenceLength: current.frames.length + imported.frames.length
    }
  };
}

export function applyBatchDecision(preview: MergePreview, decision: ConflictDecision): void {
  const used = new Set(preview.current.frames.map((f) => f.name));
  for (const c of preview.conflicts) {
    c.decision = decision;
    if (decision === "rename-import") {
      const base = c.defaultNewName || defaultImportName(c.name, used);
      c.newName = uniqueName(base, used);
      used.add(c.newName);
    }
  }
}

export function validateConflictName(preview: MergePreview, conflict: ConflictItem): string | null {
  const name = conflict.newName.trim();
  if (!name) return "新名称不能为空";
  if (/[\\/:*?"<>|]/.test(name) || [...name].some((ch) => ch.codePointAt(0)! < 32)) return "名称包含非法字符";
  if (name === conflict.name) return "重命名不能与原同名冲突名称相同";
  for (const f of preview.current.frames) {
    if (f.name === name) return "新名称与当前工程中的帧重名";
  }
  for (const c of preview.conflicts) {
    if (c !== conflict && c.decision === "rename-import" && c.newName.trim() === name) {
      return "新名称与另一项重命名冲突";
    }
  }
  for (const f of preview.imported.frames) {
    if (f.name === name) {
      const ownConflict = preview.conflicts.find((c) => c.name === name);
      if (!ownConflict) return "新名称与导入工程中的其他帧重名";
    }
  }
  return null;
}

function getConflictDecision(
  preview: MergePreview,
  decisions: MergeDecisionRecord[]
): Map<string, MergeDecisionRecord> {
  const map = new Map(decisions.map((d) => [d.name, d]));
  for (const c of preview.conflicts) {
    if (!map.has(c.name)) map.set(c.name, { name: c.name, decision: c.decision, newName: c.newName });
  }
  return map;
}

/** 根据预览与逐项决策生成不可变合并计划；所有引用必须能解析，否则抛错。 */
export function buildMergePlan(preview: MergePreview, decisions: MergeDecisionRecord[]): MergePlan {
  const decisionMap = getConflictDecision(preview, decisions);
  const currentByName = new Map<string, MergeProjectFrame>();
  for (const f of preview.current.frames) if (!currentByName.has(f.name)) currentByName.set(f.name, f);
  const importedByName = new Map<string, MergeProjectFrame>();
  for (const f of preview.imported.frames) if (!importedByName.has(f.name)) importedByName.set(f.name, f);

  const targetNameByImport = new Map<string, string>();
  const assets = new Map<string, FinalAsset>();

  for (const f of preview.current.frames) {
    if (!assets.has(f.name)) {
      assets.set(f.name, {
        name: f.name,
        digest: f.digest,
        duration: f.duration,
        width: f.width,
        height: f.height,
        blob: f.blob,
        source: "current"
      });
    }
  }

  // 同名同内容 / 同内容别名：导入引用都指向当前规范资源。
  const canonicalByDigest = new Map<string, string>();
  for (const f of preview.current.frames) {
    if (!canonicalByDigest.has(f.digest)) canonicalByDigest.set(f.digest, f.name);
  }

  for (const f of preview.imported.frames) {
    const sameDigestName = canonicalByDigest.get(f.digest);
    if (sameDigestName) {
      targetNameByImport.set(`${f.id}`, sameDigestName);
      continue;
    }
  }

  // 导入工程内部可能用多个名称引用同一内容；按摘要归并到该内容的首个名称。
  const importedDigestMembers = new Map<string, MergeProjectFrame[]>();
  for (const f of preview.imported.frames) {
    if (canonicalByDigest.has(f.digest)) continue;
    const list = importedDigestMembers.get(f.digest) ?? [];
    list.push(f);
    importedDigestMembers.set(f.digest, list);
  }
  const usedTargets = new Set(assets.keys());
  for (const c of preview.conflicts) {
    const d = decisionMap.get(c.name) ?? { name: c.name, decision: c.decision, newName: c.newName };
    const importedMembers = importedDigestMembers.get(c.imported.digest) ?? [c.imported];
    if (d.decision === "keep-current") {
      // 保留当前：导入工程的这些引用也指向当前同名帧，不新增第二份资源。
      for (const member of importedMembers) targetNameByImport.set(member.id, c.name);
    } else if (d.decision === "rename-import") {
      const target = (d.newName ?? c.newName).trim();
      if (!target || usedTargets.has(target)) {
        throw new Error(`冲突帧“${c.name}”的重命名无效或重复：${target || "(空名称)"}`);
      }
      for (const member of importedMembers) targetNameByImport.set(member.id, target);
      assets.set(target, {
        name: target,
        digest: c.imported.digest,
        duration: c.imported.duration,
        width: c.imported.width,
        height: c.imported.height,
        blob: c.imported.blob,
        source: "imported"
      });
      usedTargets.add(target);
    } else if (d.decision === "adopt-import") {
      for (const member of importedMembers) targetNameByImport.set(member.id, c.name);
      assets.set(c.name, {
        name: c.name,
        digest: c.imported.digest,
        duration: c.imported.duration,
        width: c.imported.width,
        height: c.imported.height,
        blob: c.imported.blob,
        source: "imported"
      });
      usedTargets.add(c.name);
    } else {
      throw new Error(`冲突帧“${c.name}”存在未知决策`);
    }
  }

  for (const item of preview.importedOnly) {
    const members = importedDigestMembers.get(item.digest) ?? [];
    if (members.length > 1 && members[0]!.name !== item.name) continue;
    const f = importedByName.get(item.name)!;
    if (!assets.has(item.name)) {
      assets.set(item.name, {
        name: item.name,
        digest: item.digest,
        duration: item.duration,
        width: item.width,
        height: item.height,
        blob: f.blob,
        source: "imported"
      });
      usedTargets.add(item.name);
    }
    for (const member of members.length ? members : [f]) targetNameByImport.set(member.id, item.name);
  }

  const order: MergePlan["order"] = [];
  for (const f of preview.current.frames) {
    const asset = assets.get(f.name);
    if (!asset) throw new Error(`悬空引用：当前帧 ${f.name}`);
    order.push({ name: f.name, duration: f.duration });
  }

  let deduplicatedReferences = 0;
  for (const f of preview.imported.frames) {
    const target = targetNameByImport.get(f.id);
    if (!target) throw new Error(`悬空引用：导入帧 ${f.name}`);
    if (!assets.has(target)) throw new Error(`悬空引用：${f.name} → ${target}`);
    if (target !== f.name) deduplicatedReferences++;
    order.push({ name: target, duration: f.duration });
  }

  // 重命名后，导入工程中帧表和顺序的每一处引用都映射到新名称。
  for (const c of preview.conflicts) {
    const d = decisionMap.get(c.name)!;
    if (d.decision === "adopt-import" || d.decision === "keep-current") continue;
    const target = (d.newName ?? c.newName).trim();
    const count = preview.imported.frames.filter((f) => f.name === c.name).length;
    if (count === 0) throw new Error(`悬空引用：冲突帧 ${c.name} 在导入工程中不存在`);
    for (let i = 0; i < count; i++) {
      if (!order.some((o) => o.name === target)) throw new Error(`重命名引用未同步：${c.name} → ${target}`);
    }
  }

  const finalFrameCount = assets.size;
  const decisionRecords = preview.conflicts.map((c) => {
    const d = decisionMap.get(c.name)!;
    if (d.decision === "rename-import") {
      return { name: c.name, decision: d.decision, newName: (d.newName ?? c.newName).trim() };
    }
    return { name: c.name, decision: d.decision };
  });

  return {
    assets: [...assets.values()],
    order,
    settings: preview.current.settings,
    summary: {
      currentSourceHash: preview.current.sourceHash,
      importedSourceHash: preview.imported.sourceHash,
      currentFrameCount: preview.current.frames.length,
      importedFrameCount: preview.imported.frames.length,
      finalFrameCount,
      finalSequenceLength: order.length,
      identicalCount: preview.identical.length,
      conflictCount: preview.conflicts.length,
      addedCount: [...assets.values()].filter((a) => a.source === "imported" && !currentByName.has(a.name)).length,
      deduplicatedReferences,
      decisions: decisionRecords,
      frameOrder: order.map((o) => o.name),
      undoable: true
    }
  };
}
