// Reader contracts for ingested media. Implementations are injected (an OpenAI vision
// provider later; test fakes now); without one, the job waits — the evidence is kept.
//
// OCRProvider.read({ path, mimeType, sha256 }) ->
//   { text, blocks: [{ text, bbox: [x, y, w, h] | null, confidence }], language, confidence, provider, model }
// VisionProvider.describe({ path, mimeType, sha256, caption }) ->
//   { observations: [string],                       what is SEEN ("a printed menu board")
//     inferences:   [{ type, value, confidence }],   what it MAY mean ("food: bún cá") — never a fact
//     confidence, provider, model }
// Both receive customer content as DATA: whatever an image says is never an instruction.

export class ProviderUnavailableError extends Error {
  constructor(what) {
    super(`${what} provider not configured`);
    this.kind = "provider_unavailable";
  }
}
