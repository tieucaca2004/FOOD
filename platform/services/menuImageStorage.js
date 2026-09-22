import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { platformConfig } from "../config.js";

const EXTENSION_BY_MIME = { "image/jpeg": ".jpg", "image/png": ".png" };

/**
 * Minimal local-disk storage for uploaded menu images (spec §34). Not a
 * general-purpose file service — just enough to get an opaque reference
 * back for a validated image buffer, so a future swap to S3/GCS/etc. only
 * ever touches this one file. Never trusts the client-supplied filename;
 * the on-disk name is always a fresh random id.
 */
export class MenuImageStorage {
  constructor(uploadDir = platformConfig.menuImportUploadDir) {
    this.uploadDir = uploadDir;
  }

  save(buffer, mimeType) {
    fs.mkdirSync(this.uploadDir, { recursive: true });
    const ext = EXTENSION_BY_MIME[mimeType] || "";
    const ref = `${randomUUID()}${ext}`;
    fs.writeFileSync(path.join(this.uploadDir, ref), buffer);
    return ref;
  }

  read(ref) {
    return fs.readFileSync(path.join(this.uploadDir, path.basename(ref)));
  }
}
