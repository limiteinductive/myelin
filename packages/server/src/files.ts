// Files a learner sends, such as photos of their work: kept by content hash in the learner's own
// folder, never changed and never deleted, and readable only by that learner.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PHOTO_TYPES } from "@myelin/core";

export type PhotoType = (typeof PHOTO_TYPES)[number];

/** The largest file kept: as base64 in JSON it stays under the API's 2 MB request limit. The browser shrinks a photo well below this. */
export const MAX_FILE_BYTES = 1_400_000;

const EXT: Record<PhotoType, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };

export class FileError extends Error {}

/** The image type the bytes really are, whatever they claim. */
export function sniff(bytes: Uint8Array): PhotoType | null {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  const ascii = (from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to));
  if (bytes.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  return null;
}

export class Files {
  constructor(readonly dataDir: string) {}

  private dir(userId: string): string {
    if (!/^[a-z0-9_]+$/.test(userId)) throw new Error(`bad user id ${userId}`);
    return join(this.dataDir, "files", userId);
  }

  private path(userId: string, id: string, mime: PhotoType): string {
    return join(this.dir(userId), `${id}.${EXT[mime]}`);
  }

  /** Keeps an image and returns its hash. Keeping the same bytes again is a no-op. */
  put(userId: string, bytes: Uint8Array, mime: string): { id: string; mime: PhotoType } {
    if (bytes.length === 0) throw new FileError("the file is empty");
    if (bytes.length > MAX_FILE_BYTES) throw new FileError("the file is too large");
    const real = sniff(bytes);
    if (!real || real !== mime) throw new FileError("send a JPEG, PNG or WebP image");
    const id = createHash("sha256").update(bytes).digest("hex");
    const path = this.path(userId, id, real);
    if (!existsSync(path)) {
      mkdirSync(this.dir(userId), { recursive: true });
      // Written whole, then renamed, so a reader never sees half a file.
      const tmp = `${path}.${process.pid}.tmp`;
      writeFileSync(tmp, bytes);
      renameSync(tmp, path);
    }
    return { id, mime: real };
  }

  /** The learner's file with this hash, or null if they have none. */
  get(userId: string, id: string): { bytes: Buffer; mime: PhotoType } | null {
    if (!/^[0-9a-f]{64}$/.test(id)) return null;
    for (const mime of PHOTO_TYPES) {
      const path = this.path(userId, id, mime);
      if (existsSync(path)) return { bytes: readFileSync(path), mime };
    }
    return null;
  }

  has(userId: string, id: string, mime: PhotoType): boolean {
    return /^[0-9a-f]{64}$/.test(id) && existsSync(this.path(userId, id, mime));
  }
}
