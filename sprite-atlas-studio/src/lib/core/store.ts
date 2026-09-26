import { derived, get, writable } from "svelte/store";
import type { FrameItem, PackResult, PackedFrame, Settings, TrimRect } from "./types";
import { DEFAULT_SETTINGS } from "./types";
import { computeAlphaBBox } from "./trim";
import { packFrames, type PackInput, type PackLayout } from "./pack";
import { buildAtlasJSON, parseAtlasJSON, type AtlasJSON } from "./serialize";
import {
  blobToImage,
  canvasToBlob,
  canvasToDataURL,
  ctx2d,
  dataURLToBlob,
  downloadBlob,
  imageToPixels,
  makeCanvas,
  uid
} from "./image";
import {
  clearProject,
  commitMergedProject,
  commitUndo,
  loadLastMerge,
  loadProject,
  loadUndoRecord,
  replaceProjectAndClearMerge,
  saveProject,
  toStored,
  type StoredProject
} from "./db";
import {
  buildMergePlan,
  createMergePreview,
  loadImportedProject,
  projectFromFrames,
  type MergePlan,
  type MergePreview,
  type MergeSummary
} from "./merge";

export const frames = writable<FrameItem[]>([]);
export const settings = writable<Settings>({ ...DEFAULT_SETTINGS });
export const packResult = writable<PackResult | null>(null);
export const selectedId = writable<string | null>(null);
export const busy = writable(false);
export const status = writable<{ kind: "info" | "error"; text: string } | null>(null);
export const lastMerge = writable<MergeSummary | null>(null);
export const canUndoMerge = writable(false);

export const frameCount = derived(frames, ($f) => $f.length);

let statusTimer: ReturnType<typeof setTimeout> | undefined;
export function notify(text: string, kind: "info" | "error" = "info"): void {
  status.set({ kind, text });
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => status.set(null), 5000);
}

/** 当前打包结果对应的 JSON（不含内嵌图集，供存储/导出复用） */
let lastJSON: AtlasJSON | null = null;
export function getLastJSON(): AtlasJSON | null {
  return lastJSON;
}

// ---------- 帧导入 ----------

function uniqueName(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : "";
  let i = 2;
  while (taken.has(`${stem}_${i}${ext}`)) i++;
  return `${stem}_${i}${ext}`;
}

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
        const img = await blobToImage(file);
        const name = uniqueName(file.name, taken);
        taken.add(name);
        added.push({
          id: uid(),
          name,
          duration: 100,
          width: img.naturalWidth,
          height: img.naturalHeight,
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
      lastJSON = null;
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
  packResult.set(null);
  lastJSON = null;
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
  lastJSON = null;
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

function revokeRuntime(list: FrameItem[], pack: PackResult | null): void {
  for (const f of list) URL.revokeObjectURL(f.url);
  if (pack) URL.revokeObjectURL(pack.atlasUrl);
}

export function clearAll(): void {
  revokeRuntime(get(frames), get(packResult));
  frames.set([]);
  packResult.set(null);
  selectedId.set(null);
  lastJSON = null;
  lastMerge.set(null);
  canUndoMerge.set(false);
}

// ---------- 打包 ----------

interface TrimmedFrame {
  item: FrameItem;
  canvas: HTMLCanvasElement;
  trim: TrimRect;
}

/** 裁切（或保留）单帧，返回内容画布与裁切信息 */
async function trimFrame(item: FrameItem, doTrim: boolean): Promise<TrimmedFrame> {
  const img = await blobToImage(item.blob);
  if (!doTrim) {
    const canvas = makeCanvas(item.width, item.height);
    ctx2d(canvas).drawImage(img, 0, 0);
    return { item, canvas, trim: { x: 0, y: 0, w: item.width, h: item.height } };
  }
  const pixels = imageToPixels(img, item.width, item.height);
  const bbox = computeAlphaBBox(pixels);
  if (!bbox) {
    // 完全透明：保留 1×1，避免 0 尺寸
    const canvas = makeCanvas(1, 1);
    return { item, canvas, trim: { x: 0, y: 0, w: 1, h: 1 } };
  }
  const canvas = makeCanvas(bbox.w, bbox.h);
  ctx2d(canvas).drawImage(img, bbox.x, bbox.y, bbox.w, bbox.h, 0, 0, bbox.w, bbox.h);
  return { item, canvas, trim: bbox };
}

interface BuiltPack {
  result: PackResult;
  json: AtlasJSON;
}

/** 根据帧列表重新打包；任何图片无法解码或打包失败都会抛错。 */
async function buildPackedState(
  list: FrameItem[],
  s: Settings,
  mergeSummary?: MergeSummary
): Promise<BuiltPack> {
  if (list.length === 0) throw new Error("请先导入 PNG 帧");

  const trimmed: TrimmedFrame[] = [];
  for (const item of list) trimmed.push(await trimFrame(item, s.trim));

  const inputs: PackInput[] = trimmed.map((t) => ({
    id: t.item.id,
    name: t.item.name,
    w: t.canvas.width,
    h: t.canvas.height,
    trim: t.trim,
    srcW: t.item.width,
    srcH: t.item.height,
    duration: t.item.duration
  }));

  const layout: PackLayout = packFrames(inputs, s.padding, s.maxSize, s.pot);

  // 合成图集画布
  const atlas = makeCanvas(layout.atlasWidth, layout.atlasHeight);
  const ctx = ctx2d(atlas);
  const canvasById = new Map(trimmed.map((t) => [t.item.id, t.canvas]));
  for (const f of layout.frames) {
    const c = canvasById.get(f.id);
    if (!c) throw new Error(`打包失败：缺少帧 ${f.name}`);
    ctx.drawImage(c, f.x, f.y);
  }

  const atlasBlob = await canvasToBlob(atlas);
  const result: PackResult = {
    atlasWidth: layout.atlasWidth,
    atlasHeight: layout.atlasHeight,
    frames: layout.frames,
    atlasBlob,
    atlasUrl: URL.createObjectURL(atlasBlob),
    padding: s.padding,
    trimmed: s.trim
  };
  const json = buildAtlasJSON(layout, {
    imageName: "atlas.png",
    trimmed: s.trim,
    settings: s,
    ...(mergeSummary ? { mergeSummary } : {})
  });
  return { result, json };
}

function replaceRuntime(next: {
  frames: FrameItem[];
  settings: Settings;
  pack: PackResult | null;
  json: AtlasJSON | null;
  merge: MergeSummary | null;
  undoable: boolean;
}): void {
  revokeRuntime(get(frames), get(packResult));
  frames.set(next.frames);
  settings.set(next.settings);
  packResult.set(next.pack);
  lastJSON = next.json;
  selectedId.set(next.frames[0]?.id ?? null);
  lastMerge.set(next.merge);
  canUndoMerge.set(next.undoable);
}

/** 执行打包并生成图集 */
export async function pack(): Promise<void> {
  const list = get(frames);
  if (list.length === 0) {
    notify("请先导入 PNG 帧", "error");
    return;
  }
  const s = get(settings);
  busy.set(true);
  let suppressAuto = true;
  try {
    const mergeSummaryForExport = get(lastMerge)
      ? { ...get(lastMerge)!, undoable: false }
      : undefined;
    const built = await buildPackedState(list, s, mergeSummaryForExport);
    const old = get(packResult);
    if (old) URL.revokeObjectURL(old.atlasUrl);
    packResult.set(built.result);
    lastJSON = built.json;
    suppressAuto = false;
    notify(`打包完成：${built.result.atlasWidth}×${built.result.atlasHeight}，共 ${built.result.frames.length} 帧`);
  } catch (e) {
    notify(e instanceof Error ? e.message : String(e), "error");
  } finally {
    busy.set(false);
    if (suppressAuto) scheduleSave();
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
  let json = lastJSON;
  if (s.embedAtlas) {
    const dataURL = canvasToDataURL(await blobToCanvas(p.atlasBlob));
    json = { ...lastJSON, meta: { ...lastJSON.meta, atlasDataURL: dataURL } };
  }
  downloadBlob(new Blob([JSON.stringify(json, null, 2)], { type: "application/json" }), "atlas.json");
  notify("已导出 atlas.png 与 atlas.json");
}

async function blobToCanvas(blob: Blob): Promise<HTMLCanvasElement> {
  const img = await blobToImage(blob);
  const c = makeCanvas(img.naturalWidth, img.naturalHeight);
  ctx2d(c).drawImage(img, 0, 0);
  return c;
}

// ---------- 工程合并 ----------

export async function prepareImportedMergeProject(file: File) {
  return await loadImportedProject(file);
}

export async function createPreviewFromCurrent(imported: Awaited<ReturnType<typeof prepareImportedMergeProject>>) {
  const current = get(frames).map((f) => ({
    name: f.name,
    duration: f.duration,
    width: f.width,
    height: f.height,
    blob: f.blob,
    url: f.url
  }));
  return await createMergePreview(current, get(settings), imported);
}

/**
 * 确认合并：
 * 1. 先在内存中生成所有帧、验证引用并重新打包；
 * 2. 再用一个 IndexedDB readwrite 事务同时写项目和撤销快照；
 * 3. 任一步失败都不触碰当前运行时和已提交的数据库状态。
 */
export async function confirmMerge(
  preview: MergePreview,
  decisions: MergeSummary["decisions"]
): Promise<MergeSummary> {
  busy.set(true);
  let newFrames: FrameItem[] = [];
  let built: BuiltPack | null = null;
  try {
    const plan: MergePlan = buildMergePlan(preview, decisions);
    const byName = new Map(plan.assets.map((a) => [a.name, a]));
    newFrames = plan.order.map((ref) => {
      const asset = byName.get(ref.name);
      if (!asset) throw new Error(`悬空引用：${ref.name}`);
      return {
        id: uid(),
        name: asset.name,
        duration: ref.duration,
        width: asset.width,
        height: asset.height,
        blob: asset.blob,
        url: URL.createObjectURL(asset.blob)
      };
    });

    // 立即解码所有新帧：损坏图片在事务开始前失败。
    await Promise.all(newFrames.map((f) => blobToImage(f.blob)));
    built = await buildPackedState(newFrames, plan.settings);

    const now = Date.now();
    const summary: MergeSummary = {
      id: `merge_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      createdAt: new Date(now).toISOString(),
      ...plan.summary
    };
    built.json = buildAtlasJSON(
      {
        atlasWidth: built.result.atlasWidth,
        atlasHeight: built.result.atlasHeight,
        frames: built.result.frames
      },
      {
        imageName: "atlas.png",
        trimmed: plan.settings.trim,
        settings: plan.settings,
        mergeSummary: summary
      }
    );

    const before = toStored(get(frames), get(settings), get(packResult), lastJSON);
    const mergedProject = toStored(newFrames, plan.settings, built.result, built.json);

    try {
      await commitMergedProject(mergedProject, {
        mergeId: summary.id,
        summary,
        before,
        createdAt: now
      });
    } catch (e) {
      throw new Error(`合并事务已回滚：${e instanceof Error ? e.message : String(e)}`);
    }

    replaceRuntime({
      frames: newFrames,
      settings: { ...plan.settings },
      pack: built.result,
      json: built.json,
      merge: summary,
      undoable: true
    });
    built = null; // 运行时已接管 URL
    notify("合并完成：IndexedDB 已原子更新，可撤销本次合并");
    return summary;
  } catch (e) {
    for (const f of newFrames) URL.revokeObjectURL(f.url);
    if (built) URL.revokeObjectURL(built.result.atlasUrl);
    notify(e instanceof Error ? e.message : String(e), "error");
    throw e;
  } finally {
    busy.set(false);
  }
}

export async function undoLastMerge(): Promise<void> {
  busy.set(true);
  try {
    const undo = await loadUndoRecord();
    if (!undo) throw new Error("没有可撤销的合并记录");
    const restored = await frameItemsFromStored(undo.before);
    try {
      await commitUndo(undo.before);
    } catch (e) {
      revokeRuntime(restored.frames, restored.pack);
      throw new Error(`撤销事务已回滚：${e instanceof Error ? e.message : String(e)}`);
    }
    replaceRuntime({ ...restored, merge: null, undoable: false });
    notify("已撤销最近一次合并，并恢复到合并前项目");
  } catch (e) {
    notify(e instanceof Error ? e.message : String(e), "error");
  } finally {
    busy.set(false);
  }
}

// ---------- 导入 JSON 恢复 ----------

interface RuntimeProject {
  frames: FrameItem[];
  settings: Settings;
  pack: PackResult | null;
  json: AtlasJSON | null;
}

async function frameItemsFromStored(stored: StoredProject): Promise<RuntimeProject> {
  const restoredFrames: FrameItem[] = stored.frames.map((f) => ({
    id: f.id,
    name: f.name,
    duration: f.duration,
    width: f.width,
    height: f.height,
    blob: f.blob,
    url: URL.createObjectURL(f.blob)
  }));

  let pack: PackResult | null = null;
  let json: AtlasJSON | null = null;
  if (stored.pack) {
    const parsed = parseAtlasJSON(stored.pack.json);
    const packedFrames: PackedFrame[] = parsed.frames.map((f) => ({
      id: f.id ?? restoredFrames.find((r) => r.name === f.name)?.id ?? uid(),
      name: f.name,
      x: f.frame.x,
      y: f.frame.y,
      w: f.frame.w,
      h: f.frame.h,
      trim: { ...f.spriteSourceSize },
      srcW: f.sourceSize.w,
      srcH: f.sourceSize.h,
      duration: f.duration
    }));
    pack = {
      atlasWidth: parsed.size.w,
      atlasHeight: parsed.size.h,
      frames: packedFrames,
      atlasBlob: stored.pack.atlasBlob,
      atlasUrl: URL.createObjectURL(stored.pack.atlasBlob),
      padding: parsed.settings.padding,
      trimmed: parsed.settings.trim
    };
    json = stored.pack.json;
  }

  return { frames: restoredFrames, settings: { ...DEFAULT_SETTINGS, ...stored.settings }, pack, json };
}

/**
 * 从导出的 JSON 恢复帧列表、时长与打包结果。
 * 图集图片来源：JSON 内嵌的 atlasDataURL，或用户同时选择的 atlas.png。
 */
export async function importJSON(jsonFile: File, atlasFile?: File): Promise<void> {
  busy.set(true);
  let candidate: (RuntimeProject & { merge: MergeSummary | null }) | null = null;
  try {
    const raw: unknown = JSON.parse(await jsonFile.text());
    const parsed = parseAtlasJSON(raw);

    let atlasBlob: Blob;
    if (parsed.atlasDataURL) {
      atlasBlob = dataURLToBlob(parsed.atlasDataURL);
    } else if (atlasFile) {
      atlasBlob = atlasFile;
    } else {
      throw new Error("该 JSON 未内嵌图集，请同时选择导出的 atlas.png");
    }

    const atlasImg = await blobToImage(atlasBlob);
    if (atlasImg.naturalWidth < parsed.size.w || atlasImg.naturalHeight < parsed.size.h) {
      throw new Error(
        `图集图片尺寸 ${atlasImg.naturalWidth}×${atlasImg.naturalHeight} 小于 JSON 声明的 ${parsed.size.w}×${parsed.size.h}`
      );
    }

    // 从图集切出每帧内容，再按 spriteSourceSize 放回原始尺寸画布
    const restored: FrameItem[] = [];
    const packedFrames: PackedFrame[] = [];
    for (const f of parsed.frames) {
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
      const blob = await canvasToBlob(full);
      const id = f.id ?? uid();
      restored.push({
        id,
        name: f.name,
        duration: f.duration,
        width: f.sourceSize.w,
        height: f.sourceSize.h,
        blob,
        url: URL.createObjectURL(blob)
      });
      packedFrames.push({
        id,
        name: f.name,
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

    // 强制再解码一次切出的帧；损坏内容在替换当前工程前失败。
    await Promise.all(restored.map((f) => blobToImage(f.blob)));

    const result: PackResult = {
      atlasWidth: parsed.size.w,
      atlasHeight: parsed.size.h,
      frames: packedFrames,
      atlasBlob,
      atlasUrl: URL.createObjectURL(atlasBlob),
      padding: parsed.settings.padding,
      trimmed: parsed.settings.trim
    };
    const merge = parsed.mergeSummary ? { ...parsed.mergeSummary, undoable: false } : null;
    const json = buildAtlasJSON(
      { atlasWidth: parsed.size.w, atlasHeight: parsed.size.h, frames: packedFrames },
      {
        imageName: parsed.imageName,
        trimmed: parsed.settings.trim,
        settings: parsed.settings,
        ...(merge ? { mergeSummary: merge } : {})
      }
    );
    candidate = { frames: restored, settings: { ...parsed.settings }, pack: result, json, merge };

    // 数据库原子替换成功后才切换页面状态；失败时当前工程保持不变。
    await replaceProjectAndClearMerge(toStored(restored, parsed.settings, result, json));
    const committed = candidate;
    candidate = null;
    if (committed) replaceRuntime({ ...committed, undoable: false});
    notify(`已从 JSON 恢复 ${restored.length} 个序列引用与打包结果`);
  } catch (e) {
    if (candidate) revokeRuntime(candidate.frames, candidate.pack);
    notify(e instanceof Error ? e.message : String(e), "error");
  } finally {
    busy.set(false);
  }
}

// ---------- IndexedDB 持久化 ----------

export async function saveNow(): Promise<void> {
  try {
    await saveProject(toStored(get(frames), get(settings), get(packResult), lastJSON));
    notify("项目已保存到浏览器本地");
  } catch (e) {
    notify(`保存失败：${e instanceof Error ? e.message : String(e)}`, "error");
  }
}

export async function restoreFromDB(): Promise<boolean> {
  try {
    const stored = await loadProject();
    if (!stored || stored.frames.length === 0) {
      const mergeInfo = await loadLastMerge();
      if (mergeInfo) {
        lastMerge.set({ ...mergeInfo.summary, undoable: false });
        canUndoMerge.set(false);
      }
      return false;
    }
    const restored = await frameItemsFromStored(stored);
    const undo = await loadUndoRecord();
    const mergeInfo = undo
      ? { summary: undo.summary, undoable: true }
      : await loadLastMerge().then((m) => (m ? { summary: { ...m.summary, undoable: false }, undoable: false } : null));
    replaceRuntime({
      ...restored,
      merge: mergeInfo?.summary ?? null,
      undoable: Boolean(mergeInfo?.undoable)
    });
    return true;
  } catch {
    return false;
  }
}

export async function clearStorage(): Promise<void> {
  await clearProject();
  clearAll();
  notify("已清空本地项目");
}

// 自动保存（防抖）。合并/撤销自行使用事务提交，禁止旧状态定时器覆盖原子结果。
let saveTimer: ReturnType<typeof setTimeout> | undefined;
function scheduleSave(): void {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    void saveProject(toStored(get(frames), get(settings), get(packResult), lastJSON)).catch(() => {});
  }, 600);
}

export function startAutoSave(): void {
  frames.subscribe(() => scheduleSave());
  settings.subscribe(() => scheduleSave());
  packResult.subscribe(() => scheduleSave());
}
