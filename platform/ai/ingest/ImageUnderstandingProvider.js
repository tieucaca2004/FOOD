import fs from "node:fs";

// Image understanding for customer / Knowledge Group images: ONE structured reading per image (memoised by the
// file's sha256), exposed through the capabilities the ingestion pipeline needs and adapted to its existing reader
// contracts (knowledge/ingestion/providers.js):
//   ocr.read()        -> { text, blocks, language, confidence, provider, model }            (what is WRITTEN)
//   vision.describe() -> { observations, inferences, documentType, items, merchant, address } (what it MAY be)
// Everything returned is DATA and a PROPOSAL: the document type is evidence metadata, not truth; items count only
// where the OCR text shows them (imageFindings.js); nothing here writes anything anywhere.

export const DOCUMENT_TYPES = ["MENU", "MERCHANT_SIGN", "ADDRESS", "PRICE_BOARD", "FOOD_PHOTO", "BUSINESS_CARD", "RECEIPT", "GENERAL_FOOD", "UNKNOWN"];
const MAX_TEXT = 20_000;
const MAX_ITEMS = 80;

const num01 = (v) => (typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : null);
const str = (v, max = 300) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);

/** Whatever a model returned -> the one shape the pipeline accepts (unknown fields dropped, sizes capped). */
export function sanitizeReading(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  const documentType = DOCUMENT_TYPES.includes(r.document_type) ? r.document_type : "UNKNOWN";
  const items = (Array.isArray(r.items) ? r.items : []).slice(0, MAX_ITEMS).map((i) => ({
    name: str(i?.name, 120),
    price_raw: str(i?.price_raw, 40),
    price: Number.isInteger(i?.price) ? i.price : null,
    currency: "VND",
    variant: str(i?.variant, 60),
    confidence: num01(i?.confidence),
    evidence_text: str(i?.evidence_text, 300),
  })).filter((i) => i.name);
  const entity = (e, key) => (e && typeof e === "object" && str(e[key]) ? { [key]: str(e[key], 200), confidence: num01(e.confidence) } : null);
  return {
    document_type: documentType,
    text: typeof r.text === "string" ? r.text.slice(0, MAX_TEXT) : "",
    language: str(r.language, 10),
    confidence: num01(r.confidence),
    merchant: entity(r.merchant, "name"),
    address: entity(r.address, "text"),
    items,
    observations: (Array.isArray(r.observations) ? r.observations : []).map((o) => str(o, 200)).filter(Boolean).slice(0, 10),
    food_guess: (Array.isArray(r.food_guess) ? r.food_guess : []).map((f) => ({ name: str(f?.name, 80), confidence: num01(f?.confidence) })).filter((f) => f.name).slice(0, 5),
  };
}

export class ImageUnderstandingProvider {
  constructor({ name = "image_understanding", model = null } = {}) {
    this.name = name;
    this.model = model;
    this._memo = new Map();
  }

  /** @abstract one call to the model: ({buffer, mimeType}) -> raw reading */
  async _analyze() {
    throw new Error("not implemented");
  }

  /** The structured reading of one image, once per sha256. */
  async extractEvidence({ buffer, mimeType, sha256 }) {
    const key = sha256 ?? null;
    if (key && this._memo.has(key)) return this._memo.get(key);
    const pending = this._analyze({ buffer, mimeType }).then(sanitizeReading);
    if (key) {
      this._memo.set(key, pending);
      pending.catch(() => this._memo.delete(key)); // a failure is retried later, never cached
      if (this._memo.size > 200) this._memo.delete(this._memo.keys().next().value);
    }
    return pending;
  }

  async classifyImage(img) {
    const r = await this.extractEvidence(img);
    return { document_type: r.document_type, confidence: r.confidence };
  }

  async extractText(img) {
    const r = await this.extractEvidence(img);
    return { text: r.text, language: r.language, confidence: r.confidence };
  }

  async extractMenu(img) {
    const r = await this.extractEvidence(img);
    return { document_type: r.document_type, items: r.items };
  }

  async extractMerchant(img) {
    const r = await this.extractEvidence(img);
    return { merchant: r.merchant, address: r.address };
  }

  /** The existing ingestion reader contracts, backed by the one memoised reading. */
  asReaders() {
    const load = ({ path, mimeType, sha256 }) => this.extractEvidence({ buffer: fs.readFileSync(path), mimeType, sha256 });
    return {
      ocr: {
        read: async (img) => {
          const r = await load(img);
          return { text: r.text, blocks: [], language: r.language, confidence: r.confidence, provider: this.name, model: this.model };
        },
      },
      vision: {
        describe: async (img) => {
          const r = await load(img);
          return {
            observations: r.observations,
            inferences: r.food_guess.map((f) => ({ type: "food", value: f.name, confidence: f.confidence })),
            documentType: r.document_type,
            items: r.items,
            merchant: r.merchant,
            address: r.address,
            confidence: r.confidence,
            provider: this.name,
            model: this.model,
          };
        },
      },
    };
  }
}

/** No provider configured: nothing is read; jobs wait (WAITING_PROVIDER) and the evidence is kept. */
export class NullImageUnderstanding extends ImageUnderstandingProvider {
  constructor() {
    super({ name: "null" });
  }

  asReaders() {
    return { ocr: null, vision: null };
  }
}
