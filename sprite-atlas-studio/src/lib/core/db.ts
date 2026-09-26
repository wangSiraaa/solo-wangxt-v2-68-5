import { openDB, type IDBPDatabase } from "idb";
import type { FrameItem, PackResult, Settings } from "./types";
import type { AtlasJSON } from "./serialize";
import type { MergeSummary } from "./merge";

/**
 * IndexedDB 持久化：帧 PNG（Blob）、时长、设置、最近一次打包结果和撤销记录。
 * 合并使用同一个 readwrite 事务写入，失败时不会留下半合并数据。
 */

const DB_NAME = "sprite-atlas-studio";
const STORE = "kv";
const PROJECT_KEY = "project";
const MERGE_KEY = "last-merge";
const UNDO_KEY = "undo-project";

export interface StoredPack {
  json: AtlasJSON;
  atlasBlob: Blob;
}

export interface StoredProject {
  version: 1;
  savedAt: number;
  settings: Settings;
  frames: Array<{
    id: string;
    name: string;
    duration: number;
    width: number;
    height: number;
    blob: Blob;
  }>;
  pack: StoredPack | null;
}

export interface MergeUndoRecord {
  mergeId: string;
  summary: MergeSummary;
  before: StoredProject;
  createdAt: number;
}

function db(): Promise<IDBPDatabase> {
  return openDB(DB_NAME, 1, {
    upgrade(d) {
      if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE);
    }
  });
}

export async function saveProject(p: StoredProject): Promise<void> {
  const d = await db();
  await d.put(STORE, p, PROJECT_KEY);
}

export async function loadProject(): Promise<StoredProject | null> {
  const d = await db();
  const v = (await d.get(STORE, PROJECT_KEY)) as StoredProject | undefined;
  return v ?? null;
}

export async function clearProject(): Promise<void> {
  const d = await db();
  const tx = d.transaction(STORE, "readwrite");
  await Promise.all([tx.store.delete(PROJECT_KEY), tx.store.delete(MERGE_KEY), tx.store.delete(UNDO_KEY), tx.done]);
}

/** 原子提交：项目、合并摘要、撤销前快照三者同时成功，或全部不变。 */
export async function commitMergedProject(
  project: StoredProject,
  undo: MergeUndoRecord
): Promise<void> {
  const d = await db();
  const tx = d.transaction(STORE, "readwrite");
  tx.store.put(project, PROJECT_KEY);
  tx.store.put(undo, UNDO_KEY);
  tx.store.put(
    { mergeId: undo.mergeId, summary: undo.summary, createdAt: undo.createdAt },
    MERGE_KEY
  );
  await tx.done;
}

export async function loadUndoRecord(): Promise<MergeUndoRecord | null> {
  const d = await db();
  const v = (await d.get(STORE, UNDO_KEY)) as MergeUndoRecord | undefined;
  return v ?? null;
}

export async function loadLastMerge(): Promise<{ mergeId: string; summary: MergeSummary; createdAt: number } | null> {
  const d = await db();
  const v = (await d.get(STORE, MERGE_KEY)) as
    | { mergeId: string; summary: MergeSummary; createdAt: number }
    | undefined;
  return v ?? null;
}

/** 原子撤销：恢复合并前项目，并同时移除合并/撤销记录。 */
export async function commitUndo(before: StoredProject): Promise<void> {
  const d = await db();
  const tx = d.transaction(STORE, "readwrite");
  tx.store.put(before, PROJECT_KEY);
  tx.store.delete(MERGE_KEY);
  tx.store.delete(UNDO_KEY);
  await tx.done;
}

/** 导入/清空等非合并替换：项目写入与旧撤销信息清理处于同一事务。 */
export async function replaceProjectAndClearMerge(project: StoredProject): Promise<void> {
  const d = await db();
  const tx = d.transaction(STORE, "readwrite");
  tx.store.put(project, PROJECT_KEY);
  tx.store.delete(MERGE_KEY);
  tx.store.delete(UNDO_KEY);
  await tx.done;
}

/** 只保存当前合并摘要（例如刷新后展示不可撤销的来源摘要）。 */
export async function saveLastMergeOnly(summary: MergeSummary): Promise<void> {
  const d = await db();
  await d.put(STORE, { mergeId: summary.id, summary, createdAt: Date.now() }, MERGE_KEY);
}

/** 由运行时状态构造可存储对象 */
export function toStored(
  frames: FrameItem[],
  settings: Settings,
  pack: PackResult | null,
  json: AtlasJSON | null
): StoredProject {
  return {
    version: 1,
    savedAt: Date.now(),
    settings: { ...settings },
    frames: frames.map((f) => ({
      id: f.id,
      name: f.name,
      duration: f.duration,
      width: f.width,
      height: f.height,
      blob: f.blob
    })),
    pack: pack && json ? { json, atlasBlob: pack.atlasBlob } : null
  };
}
