import { derived, get, writable } from "svelte/store";
import type { Clip, FrameItem, PackResult, PackedFrame, Settings } from "./types";
import { DEFAULT_SETTINGS } from "./types";
import { buildAtlasJSON, type AtlasJSON } from "./serialize";
import { blobToImage, canvasToDataURL, ctx2d, downloadBlob, makeCanvas, uid } from "./image";
import {
  clearAllData,
  deleteLegacyProject,
  deleteProjectAndGC,
  getCurrentProjectId,
  listMerges,
  listProjects,
  loadBlobs,
  loadProjectRecord,
  readLegacyProject,
  saveImportedProject,
  saveProjectWithBlobs,
  setCurrentProjectId,
  undoMerge,
  type MergeRecord,
  type StoredProject
} from "./db";
import { hashBlobBytes } from "./hash";
import { uniqueName, type ConflictPolicy, type ResolutionOverride } from "./merge";
import {
  executeMerge,
  preflightSource,
  type MergeSource
} from "./mergeExec";
import { browserDecoder, browserPacker, extractFrameFromAtlas, hashFrameBlob } from "./imageTools";
import { mergeSourceFromExport, projectFromExport, buildProjectExport } from "./projectIO";

export const frames = writable<FrameItem[]>([]);
export const clips = writable<Clip[]>([]);
export const selectedClipId = writable<string | null>(null);
export const settings = writable<Settings>({ ...DEFAULT_SETTINGS });
export const packResult = writable<PackResult | null>(null);
export const selectedId = writable<string | null>(null);
export const busy = writable(false);
export const status = writable<{ kind: "info" | "error"; text: string } | null>(null);

/** 本地工程列表与当前工程 */
export const projects = writable<Array<{ id: string; name: string; frameCount: number; clipCount: number }>>([]);
export const currentProjectId = writable<string | null>(null);
export const currentProjectName = writable<string>("未命名工程");

/** 当前工程的合并记录（按时间升序） */
export const mergeHistory = writable<MergeRecord[]>([]);

export const frameCount = derived(frames, ($f) => $f.length);

let statusTimer: ReturnType<typeof setTimeout> | undefined;
export function notify(text: string, kind: "info" | "error" = "info"): void {
  status.set({ kind, text });
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => status.set(null), 5000);
}

/** 当前打包结果对应的 JSON（不含内嵌图集，供存储/导出复用） */
let lastJSON: AtlasJSON | null = null;
let lastAtlasHash: string | null = null;
let currentCreatedAt = Date.now();
/** 正在从数据库加载（避免触发自动保存回写） */
let loading = false;

export function getLastJSON(): AtlasJSON | null {
  return lastJSON;
}

// ---------- 运行时 ↔ 存储 ----------

function toStoredProject(): StoredProject {
  const pack = get(packResult);
  return {
    version: 2,
    id: get(currentProjectId)!,
    name: get(currentProjectName),
    createdAt: currentCreatedAt,
    savedAt: Date.now(),
    settings: { ...get(settings) },
    frames: get(frames).map((f) => ({
      id: f.id,
      name: f.name,
      duration: f.duration,
      width: f.width,
      height: f.height,
      hash: f.hash
    })),
    clips: get(clips).map((c) => ({ ...c, frameIds: [...c.frameIds] })),
    pack: pack && lastJSON && lastAtlasHash ? { json: lastJSON, atlasHash: lastAtlasHash } : null
  };
}

/** 当前运行时持有的全部图片（帧 + 图集），按内容摘要索引 */
function runtimeBlobs(): Map<string, Blob> {
  const map = new Map<string, Blob>();
  for (const f of get(frames)) if (!map.has(f.hash)) map.set(f.hash, f.blob);
  const pack = get(packResult);
  if (pack && lastAtlasHash) map.set(lastAtlasHash, pack.atlasBlob);
  return map;
}

function revokeRuntimeUrls(): void {
  for (const f of get(frames)) URL.revokeObjectURL(f.url);
  const pack = get(packResult);
  if (pack) URL.revokeObjectURL(pack.atlasUrl);
}

function packedFramesFromJSON(json: AtlasJSON, storedFrames: StoredProject["frames"]): PackedFrame[] {
  const idByName = new Map(storedFrames.map((f) => [f.name, f.id]));
  const out: PackedFrame[] = [];
  for (const name of json.meta.frameOrder) {
    const f = json.frames[name];
    const id = idByName.get(name);
    if (!f || !id) continue;
    out.push({
      id,
      name,
      x: f.frame.x,
      y: f.frame.y,
      w: f.frame.w,
      h: f.frame.h,
      trim: { ...f.spriteSourceSize },
      srcW: f.sourceSize.w,
      srcH: f.sourceSize.h,
      duration: f.duration
    });
  }
  return out;
}

/** 把数据库中的工程加载为运行时状态 */
async function loadProjectIntoRuntime(id: string): Promise<void> {
  const rec = await loadProjectRecord(id);
  if (!rec) throw new Error("工程不存在或已被删除");
  const hashes = new Set(rec.frames.map((f) => f.hash));
  if (rec.pack) hashes.add(rec.pack.atlasHash);
  const blobs = await loadBlobs(hashes);
  for (const f of rec.frames) {
    if (!blobs.has(f.hash)) throw new Error(`工程数据不完整：帧「${f.name}」缺少图片数据`);
  }

  loading = true;
  try {
    revokeRuntimeUrls();
    currentProjectId.set(rec.id);
    currentProjectName.set(rec.name);
    currentCreatedAt = rec.createdAt;
    settings.set({ ...rec.settings });
    frames.set(
      rec.frames.map((f) => {
        const blob = blobs.get(f.hash)!;
        return { ...f, blob, url: URL.createObjectURL(blob) };
      })
    );
    clips.set(rec.clips.map((c) => ({ ...c, frameIds: [...c.frameIds] })));
    selectedClipId.set(null);
    selectedId.set(null);
    if (rec.pack) {
      const atlasBlob = blobs.get(rec.pack.atlasHash);
      if (!atlasBlob) throw new Error("工程数据不完整：缺少图集图片");
      lastJSON = rec.pack.json;
      lastAtlasHash = rec.pack.atlasHash;
      packResult.set({
        atlasWidth: rec.pack.json.meta.size.w,
        atlasHeight: rec.pack.json.meta.size.h,
        frames: packedFramesFromJSON(rec.pack.json, rec.frames),
        atlasBlob,
        atlasUrl: URL.createObjectURL(atlasBlob),
        padding: rec.settings.padding,
        trimmed: rec.settings.trim
      });
    } else {
      lastJSON = null;
      lastAtlasHash = null;
      packResult.set(null);
    }
    mergeHistory.set(await listMerges(rec.id));
  } finally {
    loading = false;
  }
}

async function refreshProjects(): Promise<void> {
  projects.set(
    (await listProjects()).map((p) => ({
      id: p.id,
      name: p.name,
      frameCount: p.frameCount,
      clipCount: p.clipCount
    }))
  );
}

/** 立即持久化当前工程（自动保存与手动保存共用） */
export async function persistNow(): Promise<void> {
  if (!get(currentProjectId)) return;
  await saveProjectWithBlobs(toStoredProject(), runtimeBlobs());
}

// ---------- 启动与迁移 ----------

function emptyProject(name: string): StoredProject {
  const now = Date.now();
  return {
    version: 2,
    id: uid(),
    name,
    createdAt: now,
    savedAt: now,
    settings: { ...DEFAULT_SETTINGS },
    frames: [],
    clips: [],
    pack: null
  };
}

/** v1 单工程记录 → v2 多工程（计算内容摘要、图片迁入内容寻址表） */
async function migrateLegacyIfNeeded(): Promise<void> {
  const legacy = await readLegacyProject();
  if (!legacy) return;
  const framesOut: StoredProject["frames"] = [];
  const blobs = new Map<string, Blob>();
  for (const f of legacy.frames) {
    let hash: string;
    try {
      hash = (await hashFrameBlob(f.blob)).hash;
    } catch {
      hash = await hashBlobBytes(f.blob); // 解码失败退化为字节摘要，不阻塞迁移
    }
    framesOut.push({ id: f.id, name: f.name, duration: f.duration, width: f.width, height: f.height, hash });
    if (!blobs.has(hash)) blobs.set(hash, f.blob);
  }
  let pack: StoredProject["pack"] = null;
  if (legacy.pack) {
    const atlasHash = await hashBlobBytes(legacy.pack.atlasBlob);
    blobs.set(atlasHash, legacy.pack.atlasBlob);
    pack = { json: legacy.pack.json, atlasHash };
  }
  const project: StoredProject = {
    version: 2,
    id: uid(),
    name: "未命名工程",
    createdAt: legacy.savedAt,
    savedAt: Date.now(),
    settings: legacy.settings,
    frames: framesOut,
    clips: [],
    pack
  };
  await saveProjectWithBlobs(project, blobs);
  await deleteLegacyProject();
}

/** 应用启动：迁移旧数据 → 加载工程列表 → 恢复当前工程 */
export async function boot(): Promise<boolean> {
  await migrateLegacyIfNeeded();
  let list = await listProjects();
  if (list.length === 0) {
    const p = emptyProject("未命名工程");
    await saveProjectWithBlobs(p, new Map());
    await setCurrentProjectId(p.id);
    list = await listProjects();
  }
  const savedId = await getCurrentProjectId();
  const target = list.find((p) => p.id === savedId)?.id ?? list[0]!.id;
  await setCurrentProjectId(target);
  await loadProjectIntoRuntime(target);
  await refreshProjects();
  return get(frames).length > 0;
}

// ---------- 帧导入 ----------

export async function addFiles(files: Iterable<File>): Promise<void> {
  const list = [...files].filter((f) => /png$/i.test(f.type) || /\.png$/i.test(f.name));
  if (list.length === 0) {
    notify("请选择 PNG 图片", "error");
    return;
  }
  busy.set(true);
  try {
    const current = get(frames);
    const taken = new Set(current.map((f) => f.name));
    const added: FrameItem[] = [];
    for (const file of list) {
      try {
        const { hash, width, height } = await hashFrameBlob(file);
        const name = uniqueName(file.name, taken);
        taken.add(name);
        added.push({
          id: uid(),
          name,
          duration: 100,
          width,
          height,
          hash,
          blob: file,
          url: URL.createObjectURL(file)
        });
      } catch {
        notify(`无法解码图片：${file.name}`, "error");
      }
    }
    if (added.length > 0) {
      frames.set([...current, ...added]);
      packResult.set(null); // 帧变化后旧的打包结果失效
      notify(`已导入 ${added.length} 帧`);
    }
  } finally {
    busy.set(false);
  }
}

export function removeFrame(id: string): void {
  const list = get(frames);
  const f = list.find((x) => x.id === id);
  if (!f) return;
  URL.revokeObjectURL(f.url);
  frames.set(list.filter((x) => x.id !== id));
  // 同步清理片段中的引用，避免悬空
  clips.set(
    get(clips).map((c) => (c.frameIds.includes(id) ? { ...c, frameIds: c.frameIds.filter((x) => x !== id) } : c))
  );
  packResult.set(null);
}

export function moveFrame(id: string, dir: -1 | 1): void {
  const list = [...get(frames)];
  const i = list.findIndex((x) => x.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= list.length) return;
  const a = list[i]!;
  list[i] = list[j]!;
  list[j] = a;
  frames.set(list);
  packResult.set(null);
}

export function setDuration(id: string, ms: number): void {
  if (!Number.isFinite(ms)) return;
  const v = Math.max(1, Math.round(ms));
  frames.set(get(frames).map((f) => (f.id === id ? { ...f, duration: v } : f)));
}

export function setAllDurations(ms: number): void {
  const v = Math.max(1, Math.round(ms));
  frames.set(get(frames).map((f) => ({ ...f, duration: v })));
}

export function clearAll(): void {
  revokeRuntimeUrls();
  frames.set([]);
  clips.set([]);
  selectedClipId.set(null);
  packResult.set(null);
  selectedId.set(null);
  lastJSON = null;
  lastAtlasHash = null;
}

// ---------- 片段（顺序引用） ----------

/** 以当前帧顺序新建片段（包含全部帧） */
export function createClip(name?: string): void {
  const list = get(frames);
  if (list.length === 0) {
    notify("请先导入帧", "error");
    return;
  }
  const taken = new Set(get(clips).map((c) => c.name));
  const clipName = name?.trim() || uniqueName("片段", taken);
  const clip: Clip = { id: uid(), name: clipName, frameIds: list.map((f) => f.id) };
  clips.set([...get(clips), clip]);
  selectedClipId.set(clip.id);
}

export function deleteClip(id: string): void {
  clips.set(get(clips).filter((c) => c.id !== id));
  if (get(selectedClipId) === id) selectedClipId.set(null);
}

export function selectClip(id: string | null): void {
  selectedClipId.set(id);
}

// ---------- 打包 ----------

/** 执行打包并生成图集 */
export async function pack(): Promise<void> {
  const list = get(frames);
  if (list.length === 0) {
    notify("请先导入 PNG 帧", "error");
    return;
  }
  const s = get(settings);
  busy.set(true);
  try {
    const { layout, atlasBlob } = await browserPacker.pack(
      list.map((f) => ({ id: f.id, name: f.name, duration: f.duration, blob: f.blob })),
      s
    );

    const old = get(packResult);
    if (old) URL.revokeObjectURL(old.atlasUrl);
    packResult.set({
      atlasWidth: layout.atlasWidth,
      atlasHeight: layout.atlasHeight,
      frames: layout.frames,
      atlasBlob,
      atlasUrl: URL.createObjectURL(atlasBlob),
      padding: s.padding,
      trimmed: s.trim
    });
    lastJSON = buildAtlasJSON(layout, {
      imageName: "atlas.png",
      trimmed: s.trim,
      settings: s,
      projectName: get(currentProjectName),
      clips: get(clips).map((c) => ({
        name: c.name,
        frames: c.frameIds.map((id) => list.find((f) => f.id === id)?.name ?? id)
      }))
    });
    lastAtlasHash = await hashBlobBytes(atlasBlob);
    notify(`打包完成：${layout.atlasWidth}×${layout.atlasHeight}，共 ${layout.frames.length} 帧`);
  } catch (e) {
    notify(e instanceof Error ? e.message : String(e), "error");
  } finally {
    busy.set(false);
  }
}

// ---------- 导出 ----------

export function exportPNG(): void {
  const p = get(packResult);
  if (!p) {
    notify("请先打包", "error");
    return;
  }
  downloadBlob(p.atlasBlob, "atlas.png");
}

export async function exportJSON(): Promise<void> {
  const p = get(packResult);
  if (!p || !lastJSON) {
    notify("请先打包", "error");
    return;
  }
  const s = get(settings);
  const json = buildProjectExport(toStoredProject(), { merges: get(mergeHistory) });
  if (s.embedAtlas) {
    json.meta.atlasDataURL = canvasToDataURL(await blobToCanvas(p.atlasBlob));
  }
  downloadBlob(new Blob([JSON.stringify(json, null, 2)], { type: "application/json" }), "atlas.json");
  notify("已导出 atlas.png 与 atlas.json（含片段与合并历史）");
}

async function blobToCanvas(blob: Blob): Promise<HTMLCanvasElement> {
  const img = await blobToImage(blob);
  const c = makeCanvas(img.naturalWidth, img.naturalHeight);
  ctx2d(c).drawImage(img, 0, 0);
  return c;
}

// ---------- 导入 JSON（作为新工程） ----------

const browserSlicer = { extractFrame: extractFrameFromAtlas };

/**
 * 从导出的 JSON 恢复为新工程（帧顺序、图集、片段与合并历史完整保留），
 * 导入后自动切换到该工程。
 */
export async function importJSON(jsonFile: File, atlasFile?: File): Promise<void> {
  busy.set(true);
  try {
    const raw: unknown = JSON.parse(await jsonFile.text());
    const imported = await projectFromExport(raw, {
      slicer: browserSlicer,
      decoder: browserDecoder,
      ...(atlasFile ? { atlasFile } : {})
    });
    await saveImportedProject(imported.project, imported.blobs, imported.merges);
    await setCurrentProjectId(imported.project.id);
    await loadProjectIntoRuntime(imported.project.id);
    await refreshProjects();
    notify(`已导入工程「${imported.project.name}」（${imported.project.frames.length} 帧）`);
  } catch (e) {
    notify(e instanceof Error ? e.message : String(e), "error");
  } finally {
    busy.set(false);
  }
}

// ---------- 工程管理 ----------

export async function createProject(name?: string): Promise<void> {
  await persistNow().catch(() => {});
  const p = emptyProject(name?.trim() || `工程 ${get(projects).length + 1}`);
  await saveProjectWithBlobs(p, new Map());
  await setCurrentProjectId(p.id);
  await loadProjectIntoRuntime(p.id);
  await refreshProjects();
  notify(`已创建工程「${p.name}」`);
}

export async function switchProject(id: string): Promise<void> {
  if (!id || id === get(currentProjectId)) return;
  await persistNow().catch(() => {});
  await setCurrentProjectId(id);
  await loadProjectIntoRuntime(id);
  await refreshProjects();
}

export async function deleteProject(id: string): Promise<void> {
  await deleteProjectAndGC(id);
  let list = await listProjects();
  if (list.length === 0) {
    const p = emptyProject("未命名工程");
    await saveProjectWithBlobs(p, new Map());
    list = await listProjects();
  }
  if (get(currentProjectId) === id) {
    await setCurrentProjectId(list[0]!.id);
    await loadProjectIntoRuntime(list[0]!.id);
  }
  await refreshProjects();
  notify("已删除工程");
}

// ---------- 合并 ----------

/** 读取本地另一个工程作为合并来源 */
export async function loadLocalSource(projectId: string): Promise<MergeSource> {
  const rec = await loadProjectRecord(projectId);
  if (!rec) throw new Error("工程不存在或已被删除");
  const blobs = await loadBlobs(rec.frames.map((f) => f.hash));
  return {
    name: rec.name,
    origin: "local",
    data: {
      name: rec.name,
      frames: rec.frames.map((f) => ({ ...f })),
      clips: rec.clips.map((c) => ({ ...c, frameIds: [...c.frameIds] }))
    },
    blobs
  };
}

/** 解析 JSON 文件作为合并来源（不落库） */
export async function parseFileSource(jsonFile: File, atlasFile?: File): Promise<MergeSource> {
  const raw: unknown = JSON.parse(await jsonFile.text());
  return mergeSourceFromExport(raw, {
    slicer: browserSlicer,
    decoder: browserDecoder,
    ...(atlasFile ? { atlasFile } : {})
  });
}

/** 预检合并来源（结构 + 逐帧解码），返回错误列表 */
export async function preflight(source: MergeSource): Promise<string[]> {
  return preflightSource(source, browserDecoder);
}

/**
 * 确认合并：校验 → 重打包 → 单事务提交。
 * 失败时抛错（数据库与运行时均保持合并前状态）；成功后运行时切换为合并结果。
 */
export async function confirmMerge(
  source: MergeSource,
  policy: ConflictPolicy,
  overrides: Record<string, ResolutionOverride>
): Promise<MergeRecord> {
  const before = toStoredProject();
  const beforeBlobs = runtimeBlobs();
  const { record, after } = await executeMerge({
    before,
    beforeBlobs,
    source,
    policy,
    overrides,
    decoder: browserDecoder,
    packer: browserPacker,
    recordId: uid()
  });
  await loadProjectIntoRuntime(after.id);
  await refreshProjects();
  const s = record.summary;
  notify(`合并完成：相同 ${s.identical} · 冲突 ${s.conflicts} · 新增 ${s.added} · 片段 ${s.clipsAdded}`);
  return record;
}

/** 撤销最近一次合并（合并记录持久化，刷新后仍可撤销） */
export async function undoLatestMerge(): Promise<boolean> {
  const rec = [...get(mergeHistory)].reverse().find((m) => !m.undone && !m.imported);
  if (!rec) {
    notify("没有可撤销的合并", "error");
    return false;
  }
  try {
    await undoMerge(rec.id);
    const id = get(currentProjectId);
    if (id) await loadProjectIntoRuntime(id);
    await refreshProjects();
    notify(`已撤销与「${rec.source.name}」的合并`);
    return true;
  } catch (e) {
    notify(e instanceof Error ? e.message : String(e), "error");
    return false;
  }
}

// ---------- 保存 / 清空 ----------

export async function saveNow(): Promise<void> {
  try {
    await persistNow();
    await refreshProjects();
    notify("项目已保存到浏览器本地");
  } catch (e) {
    notify(`保存失败：${e instanceof Error ? e.message : String(e)}`, "error");
  }
}

export async function clearStorage(): Promise<void> {
  await clearAllData();
  const p = emptyProject("未命名工程");
  await saveProjectWithBlobs(p, new Map());
  await setCurrentProjectId(p.id);
  await loadProjectIntoRuntime(p.id);
  await refreshProjects();
  notify("已清空本地项目");
}

// 自动保存（防抖）
let saveTimer: ReturnType<typeof setTimeout> | undefined;
function scheduleSave(): void {
  if (loading) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    void persistNow().catch(() => {});
  }, 600);
}

export function startAutoSave(): void {
  frames.subscribe(() => scheduleSave());
  settings.subscribe(() => scheduleSave());
  packResult.subscribe(() => scheduleSave());
  clips.subscribe(() => scheduleSave());
}
