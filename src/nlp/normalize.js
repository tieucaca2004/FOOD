export function stripAccents(text) {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/gi, "d")
    .toLowerCase();
}

const NUMBER_WORDS = {
  mot: 1,
  hai: 2,
  ba: 3,
  bon: 4,
  nam: 5,
  sau: 6,
  bay: 7,
  tam: 8,
  chin: 9,
  muoi: 10,
};

// Returns the first quantity found in the text (digit or Vietnamese number
// word), or null if none is present — callers decide the default (usually 1).
export function extractQuantity(text) {
  const normalized = stripAccents(text);
  const digitMatch = normalized.match(/\b(\d{1,3})\b/);
  if (digitMatch) return Number(digitMatch[1]);

  for (const [word, value] of Object.entries(NUMBER_WORDS)) {
    if (new RegExp(`\\b${word}\\b`).test(normalized)) return value;
  }
  return null;
}
