import type { PackLayout } from "./pack";
import type { Settings } from "./types";
import type { MergeSummary } from "./merge";

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
    /**
     * 播放顺序中的逐次引用。名称可重复，表示同一帧资源在序列中出现多次；
     * frames 仍按名称保留 TexturePacker 兼容视图。
     */
    frameEntries?: Array<AtlasJSONFrame & { id: string; name: string }>;
    /** 最近一次合并的来源与冲突决策；导出/再导入后用于核对一致性 */
    mergeSummary?: MergeSummary;
  };
}

export interface BuildJsonOptions {
  imageName: string;
  trimmed: boolean;
  settings: Settings;
  atlasDataURL?: string;
  mergeSummary?: MergeSummary;
}

/** 由打包结果生成 JSON 对象（纯函数） */
export function buildAtlasJSON(layout: PackLayout, opts: BuildJsonOptions): AtlasJSON {
  const frames: Record<string, AtlasJSONFrame> = {};
  const frameOrder: string[] = [];
  let total = 0;

  const frameEntries: NonNullable<AtlasJSON["meta"]["frameEntries"]> = [];

  for (const f of layout.frames) {
    const entry: AtlasJSONFrame = {
      frame: { x: f.x, y: f.y, w: f.w, h: f.h },
      rotated: false,
      trimmed: opts.trimmed,
      spriteSourceSize: { x: f.trim.x, y: f.trim.y, w: f.trim.w, h: f.trim.h },
      sourceSize: { w: f.srcW, h: f.srcH },
      duration: f.duration
    };
    frames[f.name] = entry;
    frameOrder.push(f.name);
    frameEntries.push({ ...entry, id: f.id, name: f.name });
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
    totalDuration: total,
    frameEntries
  };
  if (opts.atlasDataURL) meta.atlasDataURL = opts.atlasDataURL;
  if (opts.mergeSummary) meta.mergeSummary = opts.mergeSummary;

  return { frames, meta };
}

export interface ParsedFrameEntry {
  id?: string;
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
  mergeSummary?: MergeSummary;
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
  const framesRecord = raw.frames;

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
    : Object.keys(framesRecord);

  function parseEntry(f: unknown, name: string, id: string | undefined, index: number): ParsedFrameEntry {
    if (!isRecord(f)) throw new Error(`JSON 格式错误：帧 "${name}" 缺少数据`);
    const label = `frames.${name}#${index}`;
    const fr = rect(f.frame, `${label}.frame`, ["x", "y", "w", "h"]);
    const ss = rect(f.spriteSourceSize, `${label}.spriteSourceSize`, ["x", "y", "w", "h"]);
    const src = rect(f.sourceSize, `${label}.sourceSize`, ["w", "h"]);
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

    return {
      ...(typeof id === "string" ? { id } : {}),
      name,
      duration: typeof f.duration === "number" && f.duration > 0 ? f.duration : 100,
      frame,
      spriteSourceSize,
      sourceSize,
      trimmed: f.trimmed === true
    };
  }

  const rawEntries = Array.isArray(meta.frameEntries) ? meta.frameEntries : null;
  const entryNameCount = new Map<string, number>();
  if (rawEntries) {
    for (const f of rawEntries) {
      if (isRecord(f) && typeof f.name === "string") entryNameCount.set(f.name, (entryNameCount.get(f.name) ?? 0) + 1);
    }
  }
  const legacyByName = new Map(
    order.map((name, i) => [name, parseEntry(framesRecord[name], name, undefined, i)] as const)
  );
  const frames: ParsedFrameEntry[] = rawEntries
    ? rawEntries.map((f, i) => {
        if (!isRecord(f) || typeof f.name !== "string") {
          throw new Error(`JSON 格式错误：meta.frameEntries[${i}] 缺少名称`);
        }
        const entry = parseEntry(f, f.name, typeof f.id === "string" ? f.id : undefined, i);
        const legacy = legacyByName.get(entry.name);
        if (!legacy) throw new Error(`JSON 格式错误：帧 "${entry.name}" 在 frames 表中不存在`);
        const compareRects = (a: ParsedFrameEntry, b: ParsedFrameEntry): boolean => {
          const groups: Array<"frame" | "spriteSourceSize" | "sourceSize"> = ["frame", "spriteSourceSize", "sourceSize"];
          const keys = ["x", "y", "w", "h"] as const;
          return groups.every((group) =>
            keys.every((key) => (a[group] as Record<string, number | undefined>)[key] === (b[group] as Record<string, number | undefined>)[key])
          );
        };
        if ((entryNameCount.get(entry.name) ?? 0) <= 1 && !compareRects(entry, legacy)) {
          throw new Error(`JSON 格式错误：帧 "${entry.name}" 的 frameEntries 与 frames 表不一致`);
        }
        if (entry.trimmed !== legacy.trimmed) {
          throw new Error(`JSON 格式错误：帧 "${entry.name}" 的逐次引用与 frames 表不一致`);
        }
        // frameEntries 是播放顺序的权威数据；同名重复引用允许有各自时长。
        return entry;
      })
    : order.map((name, i) => parseEntry(framesRecord[name], name, undefined, i));

  if (frames.length === 0) throw new Error("JSON 中没有任何帧");

  const imageName = typeof meta.image === "string" ? meta.image : "atlas.png";
  const atlasDataURL = typeof meta.atlasDataURL === "string" ? meta.atlasDataURL : undefined;
  const mergeSummary = isRecord(meta.mergeSummary)
    ? (meta.mergeSummary as unknown as MergeSummary)
    : undefined;

  return { frames, size, settings, imageName, ...(atlasDataURL ? { atlasDataURL } : {}), ...(mergeSummary ? { mergeSummary } : {}) };
}
