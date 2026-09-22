import { MenuVisionProvider } from "../../ai/menu/MenuVisionProvider.js";

// Deterministic test double — automated tests never depend on internet
// access or a real AI API key (spec §29/§30). Configure per-test via
// `result` (a fixed OCR-shaped payload to return) or `failWith` (an Error
// to throw, for testing OCR/vision failure paths).
export class FakeMenuVisionProvider extends MenuVisionProvider {
  constructor({ result, failWith } = {}) {
    super();
    this.result = result;
    this.failWith = failWith;
    this.calls = [];
  }

  async parseImage(imageBuffer, mimeType) {
    this.calls.push({ mimeType, size: imageBuffer.length });
    if (this.failWith) throw this.failWith;
    return this.result ?? { categories: [] };
  }
}
