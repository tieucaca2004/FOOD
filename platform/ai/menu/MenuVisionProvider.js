/**
 * Vision/OCR provider contract for Menu Import (spec §12/§13/§31). A
 * provider only ever reads an image and returns structured intermediate
 * data — it never writes to the DB, never publishes, never decides
 * anything beyond "what does this image appear to say". MenuImportService
 * is the only caller, and everything a provider returns still goes
 * through menuParserService.flagDuplicates() + MenuImportService's own
 * price/name validation before it can become a MenuDraft, exactly like
 * text input.
 */
export class MenuVisionProvider {
  /**
   * @param {Buffer} _imageBuffer
   * @param {string} _mimeType
   * @returns {Promise<{categories: Array<{name: string, confidence: number|null,
   *   products: Array<{name: string, price: number|null, description: string|null,
   *   confidence: number|null}>}>}>}
   *   `confidence` is 0-1 when the provider actually supports it, or null
   *   when it doesn't — never fabricated (spec §14).
   */
  async parseImage(_imageBuffer, _mimeType) {
    throw new Error("MenuVisionProvider.parseImage not implemented");
  }
}
