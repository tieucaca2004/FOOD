import { platformConfig } from "../config.js";

const SUPPORTED_MIME_TYPES = new Set(["image/jpeg", "image/png"]);

// Magic-byte signatures — checked against the actual buffer, never the
// client-supplied MIME type or filename extension alone (spec §35).
const SIGNATURES = [
  { mimeType: "image/jpeg", bytes: [0xff, 0xd8, 0xff] },
  { mimeType: "image/png", bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
];

function matchesSignature(buffer, signature) {
  if (buffer.length < signature.bytes.length) return false;
  return signature.bytes.every((byte, i) => buffer[i] === byte);
}

function detectRealMimeType(buffer) {
  const match = SIGNATURES.find((sig) => matchesSignature(buffer, sig));
  return match ? match.mimeType : null;
}

function validationError(code, message) {
  const err = new Error(message);
  err.code = code;
  err.status = 400;
  return err;
}

/**
 * Validates an uploaded menu image. Throws (never crashes the caller) on
 * anything invalid — UNSUPPORTED_FILE for a disallowed/undetectable type,
 * FILE_TOO_LARGE, INVALID_IMAGE for a claimed type that doesn't match the
 * file's actual bytes (a corrupt file or a mislabeled one).
 * @returns {string} the verified real MIME type
 */
export function validateMenuImage(buffer, claimedMimeType) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw validationError("INVALID_IMAGE", "Empty or unreadable file");
  }
  if (buffer.length > platformConfig.menuImportMaxImageBytes) {
    throw validationError("FILE_TOO_LARGE", `Image exceeds ${platformConfig.menuImportMaxImageBytes} bytes`);
  }
  if (!SUPPORTED_MIME_TYPES.has(claimedMimeType)) {
    throw validationError("UNSUPPORTED_FILE", `Unsupported file type: ${claimedMimeType}`);
  }

  const realMimeType = detectRealMimeType(buffer);
  if (!realMimeType) {
    throw validationError("INVALID_IMAGE", "File is not a recognizable JPEG or PNG (corrupt or mislabeled)");
  }
  if (realMimeType !== claimedMimeType) {
    throw validationError("INVALID_IMAGE", `Claimed type ${claimedMimeType} does not match file contents (${realMimeType})`);
  }

  return realMimeType;
}
