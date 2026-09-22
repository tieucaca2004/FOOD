import { MenuVisionProvider } from "./MenuVisionProvider.js";

// Default when no vision provider is configured. Returns an explicit
// "not configured" failure rather than an empty-but-successful result —
// MenuImportService must be able to tell "OCR ran and found nothing"
// apart from "OCR was never actually available", so it can set the
// import to FAILED with a clear VISION_PROVIDER_ERROR instead of silently
// producing an empty draft.
export class NullMenuVisionProvider extends MenuVisionProvider {
  async parseImage(_imageBuffer, _mimeType) {
    const err = new Error("No menu vision provider configured (MENU_VISION_PROVIDER unset or no API key)");
    err.code = "VISION_PROVIDER_NOT_CONFIGURED";
    throw err;
  }
}
