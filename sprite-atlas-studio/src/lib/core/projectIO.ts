import type { AtlasJSON, ExportedMergeRecord, ParsedAtlasJSON } from "./serialize";
import { parseAtlasJSON } from "./serialize";
import type { MergeRecord, StoredClip, StoredFrame, StoredProject } from "./db";
import type { MergeSource, FrameDecoder } from "./mergeExec";
import { uniqueName, type ConflictPolicy } from "./merge";
import { hashBlobBytes, hashPixels } from "./hash";
import { dataURLToBlob, uid } from "./image";

/**
 * 工程级导出 / 导入（DOM 无关，图像操作通过接口注入）。
 *
 * 导出的 JSON 在图集信息之外附带：工程名、片段（按帧名顺序引用）、合并历史
 * （来源摘要与冲突决策）。导入时完整恢复，保证「导出再导入后帧顺序、图集
 * 和冲突决策一致」。
 */

export interface AtlasSlicer {
  /** 从图集切出一帧并按偏移放回原始尺寸，导出为 PNG */
  extractFrame(
    atlasBlob: Blob,
    frame: { x: number; y: number; w: number; h: number },
    spriteSourceSize: { x: number; y: number },
    sourceSize: { w: number; h: number }
  ): Promise<Blob>;
}

// ---------- 导出 ----------

/** 由工程记录构造可导出的 JSON（要求已打包） */
export function buildProjectExport(
  project: StoredProject,
  opts: { atlasDataURL?: string; merges: MergeRecord[] }
): AtlasJSON {
  if (!project.pack) throw new Error("工程尚未打包，无法导出");
  const json = structuredClone(project.pack.json) as AtlasJSON;

  const nameById = new Map(project.frames.map((f) => [f.id, f.name]));
  json.meta.projectName = project.name;
  const clips = project.clips
    .map((c) => ({
      name: c.name,
      frames: c.frameIds.map((id) => nameById.get(id)).filter((n): n is string => !!n)
    }))
    .filter((c) => c.frames.length > 0);
  if (clips.length > 0) json.meta.clips = clips;
  else delete json.meta.clips;

  const history: ExportedMergeRecord[] = opts.merges.map((m) => ({
    id: m.id,
    ts: m.ts,
    undone: m.undone,
    source: { ...m.source },
    decisions: { ...m.decisions },
    renames: { ...m.renames },
    summary: { ...m.summary }
  }));
  if (history.length > 0) json.meta.mergeHistory = history;
  else delete json.meta.mergeHistory;

  if (opts.atlasDataURL) json.meta.atlasDataURL = opts.atlasDataURL;
  else delete json.meta.atlasDataURL;
  return json;
}

// ---------- 导入 ----------

export interface ImportedProject {
  project: StoredProject;
  blobs: Map<string, Blob>;
  merges: MergeRecord[];
}

/** 解析导出的 JSON 并重建工程（帧图片从图集切出，内容摘要按像素重算） */
export async function projectFromExport(
  raw: unknown,
  deps: {
    slicer: AtlasSlicer;
    decoder: FrameDecoder;
    /** JSON 未内嵌图集时由调用方提供 */
    atlasFile?: Blob;
    id?: string;
    now?: number;
  }
): Promise<ImportedProject> {
  const parsed: ParsedAtlasJSON = parseAtlasJSON(raw);
  const now = deps.now ?? Date.now();
  const projectId = deps.id ?? uid();

  let atlasBlob: Blob;
  if (parsed.atlasDataURL) {
    atlasBlob = dataURLToBlob(parsed.atlasDataURL);
  } else if (deps.atlasFile) {
    atlasBlob = deps.atlasFile;
  } else {
    throw new Error("该 JSON 未内嵌图集，请同时选择导出的 atlas.png");
  }

  // 校验图集可解码且尺寸足够（损坏图片在此暴露）
  const atlasInfo = await deps.decoder.decode(atlasBlob);
  if (atlasInfo.width < parsed.size.w || atlasInfo.height < parsed.size.h) {
    throw new Error(
      `图集图片尺寸 ${atlasInfo.width}×${atlasInfo.height} 小于 JSON 声明的 ${parsed.size.w}×${parsed.size.h}`
    );
  }

  // 逐帧切出并计算内容摘要
  const frames: StoredFrame[] = [];
  const blobs = new Map<string, Blob>();
  for (const f of parsed.frames) {
    const blob = await deps.slicer.extractFrame(atlasBlob, f.frame, f.spriteSourceSize, f.sourceSize);
    const d = await deps.decoder.decode(blob);
    const hash = await hashPixels(d.pixels);
    frames.push({
      id: uid(),
      name: f.name,
      duration: f.duration,
      width: f.sourceSize.w,
      height: f.sourceSize.h,
      hash
    });
    if (!blobs.has(hash)) blobs.set(hash, blob);
  }

  // 片段：按帧名映射回帧 id（忽略悬空名称）
  const idByName = new Map(frames.map((f) => [f.name, f.id]));
  const clips: StoredClip[] = [];
  const takenClipNames = new Set<string>();
  for (const c of parsed.clips) {
    const frameIds = c.frames.map((n) => idByName.get(n)).filter((v): v is string => !!v);
    if (frameIds.length === 0) continue;
    const name = uniqueName(c.name, takenClipNames);
    takenClipNames.add(name);
    clips.push({ id: uid(), name, frameIds });
  }

  const atlasHash = await hashBlobBytes(atlasBlob);
  blobs.set(atlasHash, atlasBlob);

  // 存储用的 JSON 去掉内嵌图集（图集已在 blobs 表中）
  const storedJson = structuredClone(parsedToAtlasJSON(raw));
  delete storedJson.meta.atlasDataURL;

  const project: StoredProject = {
    version: 2,
    id: projectId,
    name: parsed.projectName ?? "导入的工程",
    createdAt: now,
    savedAt: now,
    settings: parsed.settings,
    frames,
    clips,
    pack: { json: storedJson, atlasHash }
  };

  // 合并历史：标记为导入记录（仅展示，不可撤销）
  const merges: MergeRecord[] = parsed.mergeHistory.map((m) => ({
    id: uid(),
    projectId,
    ts: m.ts,
    undone: m.undone,
    undoneAt: null,
    imported: true,
    source: {
      name: m.source.name,
      origin: "import",
      frameCount: m.source.frameCount,
      clipCount: m.source.clipCount
    },
    decisions: { ...(m.decisions as Record<string, ConflictPolicy>) },
    renames: { ...m.renames },
    summary: { ...m.summary },
    snapshot: null,
    addedBlobHashes: []
  }));

  return { project, blobs, merges };
}

/** 把解析出的 JSON 直接转换为合并来源（不落库） */
export async function mergeSourceFromExport(
  raw: unknown,
  deps: { slicer: AtlasSlicer; decoder: FrameDecoder; atlasFile?: Blob }
): Promise<MergeSource> {
  const imported = await projectFromExport(raw, deps);
  return {
    name: imported.project.name,
    origin: "file",
    data: {
      name: imported.project.name,
      frames: imported.project.frames.map((f) => ({ ...f })),
      clips: imported.project.clips.map((c) => ({ ...c, frameIds: [...c.frameIds] }))
    },
    blobs: imported.blobs
  };
}

/** 从已通过校验的原始对象取回 AtlasJSON（parseAtlasJSON 已保证结构合法） */
function parsedToAtlasJSON(raw: unknown): AtlasJSON {
  return raw as AtlasJSON;
}
