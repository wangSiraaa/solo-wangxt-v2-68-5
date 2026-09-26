/**
 * 测试辅助：Node 环境下的图像工具与工程种子。
 * 浏览器端对应实现见 src/lib/core/imageTools.ts。
 *
 * 解码用纯 JS 的 pngjs：@napi-rs/canvas 的 loadImage 遇到损坏数据会让进程崩溃，
 * 而 pngjs 只会抛普通异常，正好用于「损坏图片 → 合并回滚」的验证。
 */
import { PNG } from "pngjs";
import { createCanvas, ImageData } from "@napi-rs/canvas";
import type { AtlasPacker, FrameDecoder } from "../../src/lib/core/mergeExec";
import type { AtlasSlicer } from "../../src/lib/core/projectIO";
import { packFrames, type PackInput } from "../../src/lib/core/pack";
import { computeAlphaBBox } from "../../src/lib/core/trim";
import { DEFAULT_SETTINGS, type Pixels, type Settings } from "../../src/lib/core/types";
import { hashPixels } from "../../src/lib/core/hash";
import { saveProjectWithBlobs, type StoredClip, type StoredFrame, type StoredProject } from "../../src/lib/core/db";

function pngToPixels(png: PNG): Pixels {
  return {
    data: new Uint8ClampedArray(png.data.buffer, png.data.byteOffset, png.data.length),
    width: png.width,
    height: png.height
  };
}

async function blobToPng(blob: Blob): Promise<PNG> {
  const buf = Buffer.from(await blob.arrayBuffer());
  return PNG.sync.read(buf); // 损坏图片在此抛出普通异常
}

export const nodeDecoder: FrameDecoder = {
  async decode(blob: Blob) {
    const png = await blobToPng(blob);
    return { width: png.width, height: png.height, pixels: pngToPixels(png) };
  }
};

function pixelsToImageData(p: Pixels): ImageData {
  const d = new ImageData(p.width, p.height);
  d.data.set(p.data);
  return d;
}

export const nodePacker: AtlasPacker = {
  async pack(entries, settings: Settings) {
    const decoded: Pixels[] = [];
    for (const e of entries) decoded.push(pngToPixels(await blobToPng(e.blob)));

    const inputs: PackInput[] = entries.map((e, i) => {
      const d = decoded[i]!;
      let trim = { x: 0, y: 0, w: d.width, h: d.height };
      if (settings.trim) {
        trim = computeAlphaBBox(d) ?? { x: 0, y: 0, w: 1, h: 1 };
      }
      return {
        id: e.id,
        name: e.name,
        w: trim.w,
        h: trim.h,
        trim,
        srcW: d.width,
        srcH: d.height,
        duration: e.duration
      };
    });

    const layout = packFrames(inputs, settings.padding, settings.maxSize, settings.pot);

    const atlas = createCanvas(layout.atlasWidth, layout.atlasHeight);
    const ctx = atlas.getContext("2d");
    for (const [i, f] of layout.frames.entries()) {
      const t = inputs[i]!.trim;
      const img = pixelsToImageData(decoded[i]!);
      // 只绘制裁切区域：dirty 矩形选中源区域，落点换算到 (f.x, f.y)
      ctx.putImageData(img, f.x - t.x, f.y - t.y, t.x, t.y, t.w, t.h);
    }
    return { layout, atlasBlob: new Blob([atlas.toBuffer("image/png")], { type: "image/png" }) };
  }
};

export const nodeSlicer: AtlasSlicer = {
  async extractFrame(atlasBlob, frame, spriteSourceSize, sourceSize) {
    const atlasPixels = pngToPixels(await blobToPng(atlasBlob));
    const c = createCanvas(sourceSize.w, sourceSize.h);
    const ctx = c.getContext("2d");
    const img = pixelsToImageData(atlasPixels);
    ctx.putImageData(
      img,
      spriteSourceSize.x - frame.x,
      spriteSourceSize.y - frame.y,
      frame.x,
      frame.y,
      frame.w,
      frame.h
    );
    return new Blob([c.toBuffer("image/png")], { type: "image/png" });
  }
};

/** 生成确定性测试 PNG：相同 (w, h, seed) → 相同像素；不同 seed → 不同内容 */
export function makePng(w: number, h: number, seed: number): Blob {
  const png = new PNG({ width: w, height: h });
  const c1 = [(seed * 53) % 256, (seed * 97) % 256, (seed * 193) % 256];
  const c2 = [(seed * 29) % 256, (seed * 61) % 256, (seed * 11) % 256];
  const bx = seed % Math.max(1, w - 2);
  const by = (seed * 3) % Math.max(1, h - 2);
  const bw = Math.max(2, w >> 2);
  const bh = Math.max(2, h >> 2);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const inBox = x >= bx && x < bx + bw && y >= by && y < by + bh;
      const c = inBox ? c2 : c1;
      png.data[i] = c[0]!;
      png.data[i + 1] = c[1]!;
      png.data[i + 2] = c[2]!;
      png.data[i + 3] = 255;
    }
  }
  return new Blob([PNG.sync.write(png)], { type: "image/png" });
}

/** 损坏的图片数据（无法解码） */
export function corruptBlob(): Blob {
  return new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0xff, 0x00, 0x13, 0x37])], { type: "image/png" });
}

export interface SeedFrame {
  name: string;
  blob: Blob;
  duration?: number;
}

let seedSeq = 0;
function seedId(prefix: string): string {
  return `t_${(seedSeq++).toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** 构造工程元数据（帧摘要按像素计算），clips 按帧名引用 */
export async function buildProjectData(args: {
  id?: string;
  name: string;
  frames: SeedFrame[];
  clips?: Array<{ name: string; frames: string[] }>;
  settings?: Partial<Settings>;
}): Promise<{ project: StoredProject; blobs: Map<string, Blob> }> {
  const now = Date.now();
  const frames: StoredFrame[] = [];
  const blobs = new Map<string, Blob>();
  for (const f of args.frames) {
    const d = await nodeDecoder.decode(f.blob);
    const hash = await hashPixels(d.pixels);
    frames.push({
      id: seedId("f"),
      name: f.name,
      duration: f.duration ?? 100,
      width: d.width,
      height: d.height,
      hash
    });
    if (!blobs.has(hash)) blobs.set(hash, f.blob);
  }
  const idByName = new Map(frames.map((f) => [f.name, f.id]));
  const clips: StoredClip[] = (args.clips ?? []).map((c) => ({
    id: seedId("c"),
    name: c.name,
    frameIds: c.frames.map((n) => {
      const id = idByName.get(n);
      if (!id) throw new Error(`seed 片段引用了未知帧：${n}`);
      return id;
    })
  }));
  const project: StoredProject = {
    version: 2,
    id: args.id ?? seedId("p"),
    name: args.name,
    createdAt: now,
    savedAt: now,
    settings: { ...DEFAULT_SETTINGS, trim: false, pot: false, ...args.settings },
    frames,
    clips,
    pack: null
  };
  return { project, blobs };
}

/** 构造工程并写入 IndexedDB */
export async function seedProject(args: Parameters<typeof buildProjectData>[0]): Promise<StoredProject> {
  const { project, blobs } = await buildProjectData(args);
  await saveProjectWithBlobs(project, blobs);
  return project;
}
