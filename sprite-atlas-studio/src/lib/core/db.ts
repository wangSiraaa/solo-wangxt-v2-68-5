import { openDB, type IDBPDatabase } from "idb";
import type { Settings } from "./types";
import type { AtlasJSON } from "./serialize";
import type { ConflictPolicy } from "./merge";
import { MergeError } from "./merge";

/**
 * IndexedDB 持久化（v2）：
 * - kv        ：杂项（当前工程 id 等），并兼容 v1 的单工程记录（启动时迁移）
 * - projects  ：工程元数据（帧元信息、片段、打包结果引用），keyPath = id
 * - blobs     ：内容寻址的图片数据（帧 PNG / 图集 PNG），keyPath = hash
 * - merges    ：可撤销的合并记录（含合并前快照与本次新增的 blob 清单）
 *
 * 所有跨表写操作都在单个事务内完成：要么全部提交，要么整体回滚，
 * 不会留下半合并状态。全部数据保存在浏览器本地，不上传任何内容。
 */

const DB_NAME = "sprite-atlas-studio";
const DB_VERSION = 2;
const STORE_KV = "kv";
const STORE_PROJECTS = "projects";
const STORE_BLOBS = "blobs";
const STORE_MERGES = "merges";
const LEGACY_PROJECT_KEY = "project";
const CURRENT_PROJECT_KEY = "currentProjectId";

// ---------- 存储结构 ----------

export interface StoredFrame {
  id: string;
  name: string;
  duration: number;
  width: number;
  height: number;
  /** 像素级内容摘要（见 hash.ts） */
  hash: string;
}

export interface StoredClip {
  id: string;
  name: string;
  frameIds: string[];
}

export interface StoredPack {
  json: AtlasJSON;
  /** 图集 PNG 在 blobs 表中的键 */
  atlasHash: string;
}

export interface StoredProject {
  version: 2;
  id: string;
  name: string;
  createdAt: number;
  savedAt: number;
  settings: Settings;
  frames: StoredFrame[];
  clips: StoredClip[];
  pack: StoredPack | null;
}

export interface StoredBlob {
  hash: string;
  type: string;
  blob: Blob;
}

/** 一次合并的记录：带来源摘要与回滚所需的全部信息 */
export interface MergeRecord {
  id: string;
  /** 合并目标（当前工程） */
  projectId: string;
  ts: number;
  undone: boolean;
  undoneAt: number | null;
  /** 由 JSON 导入迁移而来的历史记录（仅展示，不可撤销） */
  imported: boolean;
  source: {
    name: string;
    origin: "local" | "file" | "import";
    frameCount: number;
    clipCount: number;
  };
  /** 冲突决策（以冲突帧名为键） */
  decisions: Record<string, ConflictPolicy>;
  /** 重命名映射：导入帧名 → 最终帧名 */
  renames: Record<string, string>;
  summary: { identical: number; conflicts: number; added: number; clipsAdded: number; clipsRenamed: number };
  /** 合并前的工程快照（撤销时恢复）；imported 记录为 null */
  snapshot: StoredProject | null;
  /** 本次合并实际写入 blobs 表的键（撤销时按引用情况回收） */
  addedBlobHashes: string[];
}

export interface ProjectSummary {
  id: string;
  name: string;
  createdAt: number;
  savedAt: number;
  frameCount: number;
  clipCount: number;
}

/** v1 的单工程存储结构（帧内联 Blob），仅用于迁移 */
export interface LegacyStoredProject {
  version: 1;
  savedAt: number;
  settings: Settings;
  frames: Array<{ id: string; name: string; duration: number; width: number; height: number; blob: Blob }>;
  pack: { json: AtlasJSON; atlasBlob: Blob } | null;
}

// ---------- 连接 ----------

let dbPromise: Promise<IDBPDatabase> | null = null;

function db(): Promise<IDBPDatabase> {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(d, oldVersion) {
        if (oldVersion < 1 && !d.objectStoreNames.contains(STORE_KV)) d.createObjectStore(STORE_KV);
        if (oldVersion < 2) {
          // v1 → v2：新增多工程 / 内容寻址图片 / 合并记录表；
          // v1 的 kv.project 数据在启动时由 migrateLegacyProject 异步迁移（升级事务内无法做哈希计算）
          if (!d.objectStoreNames.contains(STORE_KV)) d.createObjectStore(STORE_KV);
          if (!d.objectStoreNames.contains(STORE_PROJECTS)) d.createObjectStore(STORE_PROJECTS, { keyPath: "id" });
          if (!d.objectStoreNames.contains(STORE_BLOBS)) d.createObjectStore(STORE_BLOBS, { keyPath: "hash" });
          if (!d.objectStoreNames.contains(STORE_MERGES)) d.createObjectStore(STORE_MERGES, { keyPath: "id" });
        }
      }
    });
  }
  return dbPromise;
}

/** 仅供测试：关闭并遗忘当前连接（配合全新的 fake-indexeddb 实例使用） */
export async function _resetForTests(): Promise<void> {
  if (dbPromise) {
    (await dbPromise).close();
    dbPromise = null;
  }
}

// ---------- 工程读写 ----------

export async function listProjects(): Promise<ProjectSummary[]> {
  const d = await db();
  const all = (await d.getAll(STORE_PROJECTS)) as StoredProject[];
  return all
    .map((p) => ({
      id: p.id,
      name: p.name,
      createdAt: p.createdAt,
      savedAt: p.savedAt,
      frameCount: p.frames.length,
      clipCount: p.clips.length
    }))
    .sort((a, b) => a.createdAt - b.createdAt);
}

export async function loadProjectRecord(id: string): Promise<StoredProject | null> {
  const d = await db();
  return ((await d.get(STORE_PROJECTS, id)) as StoredProject | undefined) ?? null;
}

/** 按内容摘要批量读取图片数据（缺失的键不会出现在结果中） */
export async function loadBlobs(hashes: Iterable<string>): Promise<Map<string, Blob>> {
  const d = await db();
  const out = new Map<string, Blob>();
  const tx = d.transaction(STORE_BLOBS, "readonly");
  for (const h of hashes) {
    const rec = (await tx.store.get(h)) as StoredBlob | undefined;
    if (rec) out.set(h, rec.blob);
  }
  await tx.done;
  return out;
}

/** 原子保存：工程记录 + 缺失的图片数据（同事务；相同摘要的图片已存在则跳过） */
export async function saveProjectWithBlobs(project: StoredProject, blobs: Map<string, Blob>): Promise<void> {
  const d = await db();
  const tx = d.transaction([STORE_PROJECTS, STORE_BLOBS], "readwrite");
  await tx.objectStore(STORE_PROJECTS).put(project);
  const blobStore = tx.objectStore(STORE_BLOBS);
  for (const [hash, blob] of blobs) {
    if (!(await blobStore.get(hash))) {
      await blobStore.put({ hash, type: blob.type || "image/png", blob } satisfies StoredBlob);
    }
  }
  await tx.done;
}

/** 导入工程（来自 JSON）：工程 + 图片 + 合并历史，单事务写入 */
export async function saveImportedProject(
  project: StoredProject,
  blobs: Map<string, Blob>,
  merges: MergeRecord[]
): Promise<void> {
  const d = await db();
  const tx = d.transaction([STORE_PROJECTS, STORE_BLOBS, STORE_MERGES], "readwrite");
  await tx.objectStore(STORE_PROJECTS).put(project);
  const blobStore = tx.objectStore(STORE_BLOBS);
  for (const [hash, blob] of blobs) {
    if (!(await blobStore.get(hash))) {
      await blobStore.put({ hash, type: blob.type || "image/png", blob } satisfies StoredBlob);
    }
  }
  const mergeStore = tx.objectStore(STORE_MERGES);
  for (const m of merges) {
    if (!(await mergeStore.get(m.id))) await mergeStore.put(m);
  }
  await tx.done;
}

/** 删除工程及其合并记录，并回收不再被任何工程引用的图片（单事务） */
export async function deleteProjectAndGC(id: string): Promise<void> {
  const d = await db();
  const tx = d.transaction([STORE_PROJECTS, STORE_BLOBS, STORE_MERGES], "readwrite");
  await tx.objectStore(STORE_PROJECTS).delete(id);
  const mergeStore = tx.objectStore(STORE_MERGES);
  for (const m of (await mergeStore.getAll()) as MergeRecord[]) {
    if (m.projectId === id) await mergeStore.delete(m.id);
  }
  await gcBlobs(tx.objectStore(STORE_PROJECTS), tx.objectStore(STORE_BLOBS));
  await tx.done;
}

/** 回收未被任何工程（帧或图集）引用的图片 */
async function gcBlobs(
  projectsStore: { getAll(): Promise<unknown[]> },
  blobStore: { getAllKeys(): Promise<unknown[]>; delete(key: string): Promise<unknown> }
): Promise<void> {
  const referenced = new Set<string>();
  for (const p of (await projectsStore.getAll()) as StoredProject[]) {
    for (const f of p.frames) referenced.add(f.hash);
    if (p.pack) referenced.add(p.pack.atlasHash);
  }
  for (const key of (await blobStore.getAllKeys()) as string[]) {
    if (!referenced.has(key)) await blobStore.delete(key);
  }
}

// ---------- 合并：原子提交与撤销 ----------

/**
 * 原子提交合并：写入新增图片（记录实际新增的键）、合并后的工程、合并记录。
 * 调用前的校验/重打包若失败则根本不会进入本函数；本函数内任一写失败，
 * 整个事务中止，数据库保持合并前状态。
 */
export async function commitMerge(
  record: MergeRecord,
  after: StoredProject,
  newBlobs: Map<string, Blob>
): Promise<MergeRecord> {
  const d = await db();
  const tx = d.transaction([STORE_PROJECTS, STORE_BLOBS, STORE_MERGES], "readwrite");
  try {
    const blobStore = tx.objectStore(STORE_BLOBS);
    const added: string[] = [];
    for (const [hash, blob] of newBlobs) {
      if (!(await blobStore.get(hash))) {
        await blobStore.put({ hash, type: blob.type || "image/png", blob } satisfies StoredBlob);
        added.push(hash);
      }
    }
    await tx.objectStore(STORE_PROJECTS).put(after);
    const finalRecord: MergeRecord = { ...record, addedBlobHashes: added };
    await tx.objectStore(STORE_MERGES).put(finalRecord);
    await tx.done;
    return finalRecord;
  } catch (e) {
    try {
      tx.abort();
    } catch {
      /* 事务可能已结束 */
    }
    // abort 后 tx.done 会以 AbortError 拒绝，必须吞掉以避免未处理拒绝
    await tx.done.catch(() => undefined);
    throw e;
  }
}

/**
 * 撤销一次合并（单事务）：恢复合并前快照、回收本次新增且不再被引用的图片、
 * 将记录标记为已撤销。只允许撤销该工程最近一次未撤销的合并（栈语义）。
 */
export async function undoMerge(mergeId: string, now = Date.now()): Promise<MergeRecord> {
  const d = await db();
  const tx = d.transaction([STORE_PROJECTS, STORE_BLOBS, STORE_MERGES], "readwrite");
  try {
    const mergeStore = tx.objectStore(STORE_MERGES);
    const rec = (await mergeStore.get(mergeId)) as MergeRecord | undefined;
    if (!rec || rec.undone || rec.imported || !rec.snapshot) {
      throw new MergeError("nothing-to-undo", "没有可撤销的合并记录");
    }
    const siblings = ((await mergeStore.getAll()) as MergeRecord[]).filter(
      (m) => m.projectId === rec.projectId && !m.undone && !m.imported
    );
    const latest = siblings.sort((a, b) => b.ts - a.ts)[0];
    if (latest && latest.id !== rec.id) {
      throw new MergeError("not-latest", "只能撤销最近一次合并");
    }

    // 恢复合并前快照
    const restored: StoredProject = { ...rec.snapshot, savedAt: now };
    await tx.objectStore(STORE_PROJECTS).put(restored);

    // 回收本次新增且已不被引用的图片（恢复快照后重新统计引用）
    const referenced = new Set<string>();
    for (const p of (await tx.objectStore(STORE_PROJECTS).getAll()) as StoredProject[]) {
      for (const f of p.frames) referenced.add(f.hash);
      if (p.pack) referenced.add(p.pack.atlasHash);
    }
    const blobStore = tx.objectStore(STORE_BLOBS);
    for (const hash of rec.addedBlobHashes) {
      if (!referenced.has(hash)) await blobStore.delete(hash);
    }

    const finalRecord: MergeRecord = { ...rec, undone: true, undoneAt: now };
    await mergeStore.put(finalRecord);
    await tx.done;
    return finalRecord;
  } catch (e) {
    try {
      tx.abort();
    } catch {
      /* 事务可能已结束 */
    }
    // abort 后 tx.done 会以 AbortError 拒绝，必须吞掉以避免未处理拒绝
    await tx.done.catch(() => undefined);
    throw e;
  }
}

export async function listMerges(projectId: string): Promise<MergeRecord[]> {
  const d = await db();
  const all = (await d.getAll(STORE_MERGES)) as MergeRecord[];
  return all.filter((m) => m.projectId === projectId).sort((a, b) => a.ts - b.ts);
}

// ---------- 当前工程指针 / 清空 ----------

export async function getCurrentProjectId(): Promise<string | null> {
  const d = await db();
  return ((await d.get(STORE_KV, CURRENT_PROJECT_KEY)) as string | undefined) ?? null;
}

export async function setCurrentProjectId(id: string): Promise<void> {
  const d = await db();
  await d.put(STORE_KV, id, CURRENT_PROJECT_KEY);
}

export async function clearAllData(): Promise<void> {
  const d = await db();
  const tx = d.transaction([STORE_KV, STORE_PROJECTS, STORE_BLOBS, STORE_MERGES], "readwrite");
  await Promise.all([
    tx.objectStore(STORE_KV).clear(),
    tx.objectStore(STORE_PROJECTS).clear(),
    tx.objectStore(STORE_BLOBS).clear(),
    tx.objectStore(STORE_MERGES).clear()
  ]);
  await tx.done;
}

// ---------- v1 迁移 ----------

/** 读取 v1 遗留的单工程记录（不存在则返回 null）；迁移成功后由调用方删除 */
export async function readLegacyProject(): Promise<LegacyStoredProject | null> {
  const d = await db();
  const v = await d.get(STORE_KV, LEGACY_PROJECT_KEY);
  return v && v.version === 1 ? (v as LegacyStoredProject) : null;
}

export async function deleteLegacyProject(): Promise<void> {
  const d = await db();
  await d.delete(STORE_KV, LEGACY_PROJECT_KEY);
}
