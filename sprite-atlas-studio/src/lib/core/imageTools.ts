import type { PackLayout } from "./pack";
import { packFrames, type PackInput } from "./pack";
import { computeAlphaBBox } from "./trim";
import type { Pixels, Settings, TrimRect } from "./types";
import { blobToImage, canvasToBlob, ctx2d, imageToPixels, makeCanvas } from "./image";
import { hashPixels } from "./hash";
import type { AtlasPacker, FrameDecoder } from "./mergeExec";

/**
 * 浏览器端图像工具：解码校验、像素读取、裁切打包合成。
 * 全部在本地完成，图片不离开浏览器。
 */

async function decodeToImage(blob: Blob): Promise<HTMLImageElement> {
  // blobToImage 在解码失败时 reject（图片损坏）
  return blobToImage(blob);
}

/** 浏览器版帧解码器：解码 + 读取像素（用于内容摘要与裁切） */
export const browserDecoder: FrameDecoder = {
  async decode(blob: Blob) {
    const img = await decodeToImage(blob);
    const pixels = imageToPixels(img, img.naturalWidth, img.naturalHeight);
    return { width: img.naturalWidth, height: img.naturalHeight, pixels };
  }
};

interface TrimmedEntry {
  canvas: HTMLCanvasElement;
  trim: TrimRect;
  srcW: number;
  srcH: number;
}

/** 解码单帧并裁切（或保留原图），一次解码返回内容画布、裁切信息与原始尺寸 */
async function trimEntry(blob: Blob, doTrim: boolean): Promise<TrimmedEntry> {
  const img = await decodeToImage(blob);
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  if (!doTrim) {
    const canvas = makeCanvas(w, h);
    ctx2d(canvas).drawImage(img, 0, 0);
    return { canvas, trim: { x: 0, y: 0, w, h }, srcW: w, srcH: h };
  }
  const pixels: Pixels = imageToPixels(img, w, h);
  const bbox = computeAlphaBBox(pixels);
  if (!bbox) {
    // 完全透明：保留 1×1，避免 0 尺寸
    return { canvas: makeCanvas(1, 1), trim: { x: 0, y: 0, w: 1, h: 1 }, srcW: w, srcH: h };
  }
  const canvas = makeCanvas(bbox.w, bbox.h);
  ctx2d(canvas).drawImage(img, bbox.x, bbox.y, bbox.w, bbox.h, 0, 0, bbox.w, bbox.h);
  return { canvas, trim: bbox, srcW: w, srcH: h };
}

/** 浏览器版图集打包器：裁切 → maxrects 布局 → 合成图集 PNG */
export const browserPacker: AtlasPacker = {
  async pack(entries, settings: Settings): Promise<{ layout: PackLayout; atlasBlob: Blob }> {
    const trimmed: TrimmedEntry[] = [];
    for (const e of entries) trimmed.push(await trimEntry(e.blob, settings.trim));

    const inputs: PackInput[] = entries.map((e, i) => ({
      id: e.id,
      name: e.name,
      w: trimmed[i]!.canvas.width,
      h: trimmed[i]!.canvas.height,
      trim: trimmed[i]!.trim,
      srcW: trimmed[i]!.srcW,
      srcH: trimmed[i]!.srcH,
      duration: e.duration
    }));

    const layout = packFrames(inputs, settings.padding, settings.maxSize, settings.pot);

    const atlas = makeCanvas(layout.atlasWidth, layout.atlasHeight);
    const ctx = ctx2d(atlas);
    for (const [i, f] of layout.frames.entries()) {
      ctx.drawImage(trimmed[i]!.canvas, f.x, f.y);
    }
    const atlasBlob = await canvasToBlob(atlas);
    return { layout, atlasBlob };
  }
};

/** 计算帧图片的像素级内容摘要 */
export async function hashFrameBlob(blob: Blob): Promise<{ hash: string; width: number; height: number }> {
  const d = await browserDecoder.decode(blob);
  return { hash: await hashPixels(d.pixels), width: d.width, height: d.height };
}

/**
 * 从图集切出一帧并按 spriteSourceSize 偏移放回原始尺寸画布，导出为 PNG。
 * 用于「导入 JSON 恢复」。
 */
export async function extractFrameFromAtlas(
  atlasBlob: Blob,
  frame: { x: number; y: number; w: number; h: number },
  spriteSourceSize: { x: number; y: number },
  sourceSize: { w: number; h: number }
): Promise<Blob> {
  const img = await decodeToImage(atlasBlob);
  const canvas = makeCanvas(sourceSize.w, sourceSize.h);
  ctx2d(canvas).drawImage(
    img,
    frame.x,
    frame.y,
    frame.w,
    frame.h,
    spriteSourceSize.x,
    spriteSourceSize.y,
    frame.w,
    frame.h
  );
  return canvasToBlob(canvas);
}
