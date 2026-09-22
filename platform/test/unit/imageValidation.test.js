import { test } from "node:test";
import assert from "node:assert/strict";
import { validateMenuImage } from "../../services/imageValidation.js";

const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]);
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

test("valid JPEG passes validation and returns the real mime type", () => {
  assert.equal(validateMenuImage(JPEG_MAGIC, "image/jpeg"), "image/jpeg");
});

test("valid PNG passes validation", () => {
  assert.equal(validateMenuImage(PNG_MAGIC, "image/png"), "image/png");
});

test("unsupported claimed mime type is rejected as UNSUPPORTED_FILE", () => {
  assert.throws(() => validateMenuImage(JPEG_MAGIC, "image/gif"), (err) => {
    assert.equal(err.code, "UNSUPPORTED_FILE");
    return true;
  });
});

test("oversized file is rejected as FILE_TOO_LARGE", () => {
  const big = Buffer.concat([JPEG_MAGIC, Buffer.alloc(20 * 1024 * 1024)]);
  assert.throws(() => validateMenuImage(big, "image/jpeg"), (err) => {
    assert.equal(err.code, "FILE_TOO_LARGE");
    return true;
  });
});

test("corrupt/non-image bytes claimed as an image are rejected as INVALID_IMAGE", () => {
  const notAnImage = Buffer.from("this is just plain text, not an image at all");
  assert.throws(() => validateMenuImage(notAnImage, "image/jpeg"), (err) => {
    assert.equal(err.code, "INVALID_IMAGE");
    return true;
  });
});

test("claimed type mismatching the real file bytes is rejected — never trusts the claimed MIME/extension alone", () => {
  assert.throws(() => validateMenuImage(PNG_MAGIC, "image/jpeg"), (err) => {
    assert.equal(err.code, "INVALID_IMAGE");
    return true;
  });
});

test("empty buffer is rejected, never crashes the caller", () => {
  assert.throws(() => validateMenuImage(Buffer.alloc(0), "image/jpeg"), (err) => {
    assert.equal(err.code, "INVALID_IMAGE");
    return true;
  });
});
