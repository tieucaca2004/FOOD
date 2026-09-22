// Rule-based intent classifier. Each rule: keywords (lowercase, accent-insensitive
// match against a normalized copy of the text) + a confidence score. Highest
// scoring match wins; below config.minConfidence the intent degrades to
// "support_other_ambiguous" (never a hard refusal — the responder decides
// what to do with low-confidence turns).

function stripAccents(text) {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/gi, "d")
    .toLowerCase();
}

const RULES = [
  {
    intent: "support_food_recommendation",
    confidence: 0.9,
    keywords: [
      "quan an",
      "quan ngon",
      "an gi ngon",
      "cho an ngon",
      "chao vit",
      "com tam",
      "bun cha ca",
      "quan nhau",
      "gan day co quan",
      "goi y quan",
    ],
  },
  {
    intent: "domain_open_status",
    confidence: 0.85,
    keywords: ["mo nganh", "khoa hoc", "hoc phi", "lop hoc", "dang ky hoc"],
  },
  {
    intent: "greeting",
    confidence: 0.8,
    keywords: ["xin chao", "chao shop", "chao ad", "hi", "hello"],
  },
];

export function classifyIntent(text) {
  const normalized = stripAccents(text || "");

  let best = { intent: "support_other_ambiguous", confidence: 0 };
  for (const rule of RULES) {
    const hit = rule.keywords.some((kw) => normalized.includes(kw));
    if (hit && rule.confidence > best.confidence) {
      best = { intent: rule.intent, confidence: rule.confidence };
    }
  }
  return best;
}
