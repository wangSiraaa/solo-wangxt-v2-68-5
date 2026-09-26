import type { PackLayout } from "./pack";
import type { Settings } from "./types";

/**
 * 图集 JSON 格式：兼容 TexturePacker "Hash" 结构，
 * 并扩展 duration / frameOrder / settings / atlasDataURL，
 * 使重新导入后能完整恢复帧列表、顺序、时长与打包结果。
 */

export const JSON_APP_ID = "sprite-atlas-studio";
export const JSON_VERSION = "1.0.0";

export interface AtlasJSONFrame {
  frame: { x: number; y: number; w: number; h: number };
  rotated: false;
  trimmed: boolean;
  spriteSourceSize: { x: number; y: number; w: number; h: number };
  sourceSize: { w: number; h: number };
  /** 帧时长（毫秒） */
  duration: number;
}

/** 导出到 JSON 的合并历史记录（仅摘要与决策，不含回滚快照） */
export interface ExportedMergeRecord {
  id: string;
  ts: number;
  undone: boolean;
  source: { name: string; origin: string; frameCount: number; clipCount: number };
  decisions: Record<string, string>;
  renames: Record<string, string>;
  summary: { identical: number; conflicts: number; added: number; clipsAdded: number; clipsRenamed: number };
}

export interface AtlasJSONClip {
  name: string;
  /** 按顺序引用的帧名 */
  frames: string[];
}

export interface AtlasJSON {
  frames: Record<string, AtlasJSONFrame>;
  meta: {
    app: string;
    version: string;
    image: string;
    format: string;
    size: { w: number; h: number };
    scale: string;
    /** 原始帧顺序（frames 对象的键按此排列） */
    frameOrder: string[];
    settings: {
      trim: boolean;
      padding: number;
      maxSize: number;
      pot: boolean;
    };
    /** 一轮动画总时长（毫秒） */
    totalDuration: number;
    /** 内嵌图集（data:image/png;base64,...），存在时可独立恢复 */
    atlasDataURL?: string;
    /** 工程名（导入时作为新工程名） */
    projectName?: string;
    /** 动画片段（按帧名顺序引用） */
    clips?: AtlasJSONClip[];
    /** 合并历史（来源摘要与冲突决策） */
    mergeHistory?: ExportedMergeRecord[];
  };
}

export interface BuildJsonOptions {
  imageName: string;
  trimmed: boolean;
  settings: Settings;
  atlasDataURL?: string;
  projectName?: string;
  clips?: AtlasJSONClip[];
  mergeHistory?: ExportedMergeRecord[];
}

/** 由打包结果生成 JSON 对象（纯函数） */
export function buildAtlasJSON(layout: PackLayout, opts: BuildJsonOptions): AtlasJSON {
  const frames: Record<string, AtlasJSONFrame> = {};
  const frameOrder: string[] = [];
  let total = 0;

  for (const f of layout.frames) {
    frames[f.name] = {
      frame: { x: f.x, y: f.y, w: f.w, h: f.h },
      rotated: false,
      trimmed: opts.trimmed,
      spriteSourceSize: { x: f.trim.x, y: f.trim.y, w: f.trim.w, h: f.trim.h },
      sourceSize: { w: f.srcW, h: f.srcH },
      duration: f.duration
    };
    frameOrder.push(f.name);
    total += Math.max(1, f.duration);
  }

  const meta: AtlasJSON["meta"] = {
    app: JSON_APP_ID,
    version: JSON_VERSION,
    image: opts.imageName,
    format: "RGBA8888",
    size: { w: layout.atlasWidth, h: layout.atlasHeight },
    scale: "1",
    frameOrder,
    settings: {
      trim: opts.settings.trim,
      padding: opts.settings.padding,
      maxSize: opts.settings.maxSize,
      pot: opts.settings.pot
    },
    totalDuration: total
  };
  if (opts.atlasDataURL) meta.atlasDataURL = opts.atlasDataURL;
  if (opts.projectName) meta.projectName = opts.projectName;
  if (opts.clips && opts.clips.length > 0) meta.clips = opts.clips;
  if (opts.mergeHistory && opts.mergeHistory.length > 0) meta.mergeHistory = opts.mergeHistory;

  return { frames, meta };
}

export interface ParsedFrameEntry {
  name: string;
  duration: number;
  frame: { x: number; y: number; w: number; h: number };
  spriteSourceSize: { x: number; y: number; w: number; h: number };
  sourceSize: { w: number; h: number };
  trimmed: boolean;
}

export interface ParsedAtlasJSON {
  /** 按 frameOrder 排列的帧 */
  frames: ParsedFrameEntry[];
  size: { w: number; h: number };
  settings: Settings;
  imageName: string;
  atlasDataURL?: string;
  projectName?: string;
  /** 动画片段（按帧名顺序引用）；旧格式无此字段时为空数组 */
  clips: AtlasJSONClip[];
  /** 合并历史；旧格式无此字段时为空数组 */
  mergeHistory: ExportedMergeRecord[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function num(v: unknown, field: string): number {
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new Error(`JSON 格式错误：字段 ${field} 应为数字`);
  }
  return v;
}

function rect(v: unknown, field: string, keys: readonly string[]): Record<string, number> {
  if (!isRecord(v)) throw new Error(`JSON 格式错误：字段 ${field} 应为对象`);
  const out: Record<string, number> = {};
  for (const k of keys) out[k] = num(v[k], `${field}.${k}`);
  return out;
}

/** 解析并校验图集 JSON（纯函数），不合法时抛出中文错误 */
export function parseAtlasJSON(raw: unknown): ParsedAtlasJSON {
  if (!isRecord(raw)) throw new Error("JSON 格式错误：顶层应为对象");
  if (!isRecord(raw.meta)) throw new Error("JSON 格式错误：缺少 meta");
  if (!isRecord(raw.frames)) throw new Error("JSON 格式错误：缺少 frames");

  const meta = raw.meta;
  if (meta.app !== JSON_APP_ID) {
    throw new Error(`无法识别的 JSON：meta.app 应为 "${JSON_APP_ID}"`);
  }
  if (!isRecord(meta.size)) throw new Error("JSON 格式错误：缺少 meta.size");
  const size = { w: num(meta.size.w, "meta.size.w"), h: num(meta.size.h, "meta.size.h") };

  const settingsRaw = isRecord(meta.settings) ? meta.settings : {};
  const settings: Settings = {
    trim: settingsRaw.trim !== false,
    padding: typeof settingsRaw.padding === "number" ? settingsRaw.padding : 0,
    maxSize: typeof settingsRaw.maxSize === "number" ? settingsRaw.maxSize : size.w,
    pot: settingsRaw.pot !== false,
    embedAtlas: true
  };

  const order: string[] = Array.isArray(meta.frameOrder)
    ? meta.frameOrder.filter((n): n is string => typeof n === "string")
    : Object.keys(raw.frames);

  const frames: ParsedFrameEntry[] = [];
  for (const name of order) {
    const f = raw.frames[name];
    if (!isRecord(f)) throw new Error(`JSON 格式错误：帧 "${name}" 缺少数据`);
    const fr = rect(f.frame, `frames.${name}.frame`, ["x", "y", "w", "h"]);
    const ss = rect(f.spriteSourceSize, `frames.${name}.spriteSourceSize`, ["x", "y", "w", "h"]);
    const src = rect(f.sourceSize, `frames.${name}.sourceSize`, ["w", "h"]);
    const frame = { x: fr.x!, y: fr.y!, w: fr.w!, h: fr.h! };
    const spriteSourceSize = { x: ss.x!, y: ss.y!, w: ss.w!, h: ss.h! };
    const sourceSize = { w: src.w!, h: src.h! };

    if (frame.w < 0 || frame.h < 0) throw new Error(`JSON 格式错误：帧 "${name}" 尺寸非法`);
    if (frame.x + frame.w > size.w || frame.y + frame.h > size.h) {
      throw new Error(`JSON 格式错误：帧 "${name}" 超出图集范围`);
    }
    if (spriteSourceSize.x + spriteSourceSize.w > sourceSize.w ||
        spriteSourceSize.y + spriteSourceSize.h > sourceSize.h) {
      throw new Error(`JSON 格式错误：帧 "${name}" 的裁切区域超出原始尺寸`);
    }

    frames.push({
      name,
      duration: typeof f.duration === "number" && f.duration > 0 ? f.duration : 100,
      frame,
      spriteSourceSize,
      sourceSize,
      trimmed: f.trimmed === true
    });
  }

  if (frames.length === 0) throw new Error("JSON 中没有任何帧");

  const imageName = typeof meta.image === "string" ? meta.image : "atlas.png";
  const atlasDataURL = typeof meta.atlasDataURL === "string" ? meta.atlasDataURL : undefined;
  const projectName = typeof meta.projectName === "string" ? meta.projectName : undefined;

  // 片段与合并历史为可选扩展字段，做宽松校验（不合法则忽略，保证旧格式兼容）
  const clips: AtlasJSONClip[] = [];
  if (Array.isArray(meta.clips)) {
    for (const c of meta.clips) {
      if (isRecord(c) && typeof c.name === "string" && Array.isArray(c.frames)) {
        clips.push({ name: c.name, frames: c.frames.filter((n): n is string => typeof n === "string") });
      }
    }
  }
  const mergeHistory: ExportedMergeRecord[] = [];
  if (Array.isArray(meta.mergeHistory)) {
    const safeNum = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
    for (const m of meta.mergeHistory) {
      if (isRecord(m) && typeof m.id === "string" && isRecord(m.source) && isRecord(m.summary)) {
        mergeHistory.push({
          id: m.id,
          ts: typeof m.ts === "number" ? m.ts : 0,
          undone: m.undone === true,
          source: {
            name: typeof m.source.name === "string" ? m.source.name : "未知工程",
            origin: typeof m.source.origin === "string" ? m.source.origin : "import",
            frameCount: safeNum(m.source.frameCount),
            clipCount: safeNum(m.source.clipCount)
          },
          decisions: isRecord(m.decisions) ? (m.decisions as Record<string, string>) : {},
          renames: isRecord(m.renames) ? (m.renames as Record<string, string>) : {},
          summary: {
            identical: safeNum(m.summary.identical),
            conflicts: safeNum(m.summary.conflicts),
            added: safeNum(m.summary.added),
            clipsAdded: safeNum(m.summary.clipsAdded),
            clipsRenamed: safeNum(m.summary.clipsRenamed)
          }
        });
      }
    }
  }

  return {
    frames,
    size,
    settings,
    imageName,
    ...(atlasDataURL ? { atlasDataURL } : {}),
    ...(projectName ? { projectName } : {}),
    clips,
    mergeHistory
  };
}
