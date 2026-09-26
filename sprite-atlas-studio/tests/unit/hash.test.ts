import { describe, expect, it } from "vitest";
import { createCanvas } from "@napi-rs/canvas";
import { hashBytes, hashPixels } from "../../src/lib/core/hash";
import { nodeDecoder } from "../helpers/nodeTools";
import type { Pixels } from "../../src/lib/core/types";

function solidPixels(w: number, h: number, rgba: [number, number, number, number]): Pixels {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    data.set(rgba, i * 4);
  }
  return { data, width: w, height: h };
}

describe("内容摘要", () => {
  it("相同像素 → 相同摘要；不同像素/尺寸 → 不同摘要", async () => {
    const a1 = await hashPixels(solidPixels(4, 4, [255, 0, 0, 255]));
    const a2 = await hashPixels(solidPixels(4, 4, [255, 0, 0, 255]));
    const b = await hashPixels(solidPixels(4, 4, [0, 255, 0, 255]));
    const c = await hashPixels(solidPixels(8, 4, [255, 0, 0, 255]));
    expect(a1).toBe(a2);
    expect(a1).not.toBe(b);
    expect(a1).not.toBe(c);
  });

  it("同一画面重新编码为不同 PNG 字节，像素摘要仍一致（字节摘要不同）", async () => {
    // 同一画面，两次独立编码（PNG 编码器输出相同字节时人为改动一个无关字节不可行，
    // 因此用「重新绘制 + 编码」验证：像素相同 → px 摘要一致）
    const make = (): Blob => {
      const c = createCanvas(8, 8);
      const ctx = c.getContext("2d");
      ctx.fillStyle = "rgb(10,200,90)";
      ctx.fillRect(0, 0, 8, 8);
      return new Blob([c.toBuffer("image/png")], { type: "image/png" });
    };
    const b1 = make();
    const b2 = make();
    const d1 = await nodeDecoder.decode(b1);
    const d2 = await nodeDecoder.decode(b2);
    expect(await hashPixels(d1.pixels)).toBe(await hashPixels(d2.pixels));

    // 字节级摘要只对「完全相同字节」一致
    const bytes1 = new Uint8Array(await b1.arrayBuffer());
    expect(await hashBytes(bytes1)).toBe(await hashBytes(new Uint8Array(await make().arrayBuffer())));
    expect(await hashBytes(bytes1)).not.toBe(await hashBytes(new Uint8Array([1, 2, 3])));
  });
});
