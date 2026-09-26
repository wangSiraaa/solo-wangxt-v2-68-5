import type { Pixels } from "./types";

/**
 * 内容摘要：合并时用 SHA-256 识别「相同帧」。
 * 浏览器与 Node（>=20）均可运行（WebCrypto subtle）。
 */

/** 计算字节序列的 SHA-256（十六进制小写） */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error("当前环境不支持 WebCrypto（需要安全上下文或 Node >= 20）");
  // slice() 得到独立 ArrayBuffer 副本，满足 BufferSource 类型且不受共享缓冲影响
  const digest = await subtle.digest("SHA-256", bytes.slice());
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * 像素级内容摘要：宽度、高度与全部 RGBA 数据一起参与摘要。
 * 画面相同（即使 PNG 重新编码、字节不同）摘要也一致，
 * 因此「导出 → 再导入」后的帧仍能被识别为相同内容。
 */
export async function hashPixels(pixels: Pixels): Promise<string> {
  const head = new Uint8Array(8);
  const view = new DataView(head.buffer);
  view.setUint32(0, pixels.width, true);
  view.setUint32(4, pixels.height, true);
  const body = new Uint8Array(pixels.data.buffer, pixels.data.byteOffset, pixels.data.byteLength);
  const joined = new Uint8Array(head.length + body.length);
  joined.set(head, 0);
  joined.set(body, head.length);
  return `px:${await sha256Hex(joined)}`;
}

/** 字节级摘要：用于图集等只需要存储键、不要求编码无关的场景 */
export async function hashBytes(bytes: Uint8Array): Promise<string> {
  return `raw:${await sha256Hex(bytes)}`;
}

/** 对 Blob 内容做字节级摘要 */
export async function hashBlobBytes(blob: Blob): Promise<string> {
  return hashBytes(new Uint8Array(await blob.arrayBuffer()));
}
