// A photo of work on paper, made small enough to send and still read: at most MAX_SIDE pixels on its
// longer side, as JPEG. The server keeps it by hash; the message names it.

/** The longest side a photo is sent at. Handwriting stays legible and the file stays small. */
export const MAX_SIDE = 1600;
/** Photos in one message. */
export const MAX_PHOTOS = 4;
/** Under the server's limit once in base64. */
const MAX_BYTES = 1_200_000;

/** The size to draw an image at so its longer side is at most `max`. Never enlarged. */
export function fit(width: number, height: number, max = MAX_SIDE): { width: number; height: number } {
  const scale = Math.min(1, max / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

export interface Shrunk {
  blob: Blob;
  /** The bytes in base64, for the upload. */
  data: string;
  mime: "image/jpeg";
  width: number;
  height: number;
}

/** Decodes an image file (turned the way the camera held it), scales it down and encodes it as JPEG. Throws if it is not an image the browser can read. */
export async function shrink(file: Blob): Promise<Shrunk> {
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  try {
    const { width, height } = fit(bitmap.width, bitmap.height);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no canvas");
    // JPEG has no transparency: a transparent image is laid on paper white, not black.
    ctx.fillStyle = "white";
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(bitmap, 0, 0, width, height);
    let blob: Blob | null = null;
    for (const quality of [0.85, 0.7, 0.55]) {
      blob = await new Promise<Blob | null>((done) => canvas.toBlob(done, "image/jpeg", quality));
      if (blob && blob.size <= MAX_BYTES) break;
    }
    if (!blob) throw new Error("not encoded");
    return { blob, data: await base64(blob), mime: "image/jpeg", width, height };
  } finally {
    bitmap.close();
  }
}

function base64(blob: Blob): Promise<string> {
  return new Promise((done, fail) => {
    const r = new FileReader();
    r.onload = () => done(String(r.result).slice(String(r.result).indexOf(",") + 1));
    r.onerror = () => fail(r.error);
    r.readAsDataURL(blob);
  });
}
