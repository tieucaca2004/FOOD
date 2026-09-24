import { foldText } from "./foldText.js";

// Deterministic reading of a customer's message inside a generic merchant:
// show the menu, view/clear the cart, place the order, or add a dish from
// THIS merchant's product list. It only translates text into an intent —
// quantity limits, availability, prices, merchant scope and ownership are
// all enforced by CartService/OrderService, never here.

const NUMBER_WORDS = { mot: 1, hai: 2, ba: 3, bon: 4, tu: 4, nam: 5, sau: 6, bay: 7, tam: 8, chin: 9, muoi: 10 };
const LEADING_VERBS = [
  ["cho", "toi"], ["cho", "minh"], ["cho", "em"], ["cho", "anh"], ["cho", "chi"],
  ["cho"], ["them"], ["lay"], ["goi"], ["mua"], ["dat"], ["an"], ["uong"],
];
const UNITS = new Set(["phan", "ly", "coc", "to", "dia", "suat", "hop", "chai", "lon", "mon", "cai"]);
const TRAILING_FILLERS = new Set(["nha", "nhe", "a", "voi", "di", "nua", "luon"]);
const DEICTIC = new Set(["nay", "do", "kia"]);

const PLACE_ORDER = /^(?:cho (?:toi|minh|em) )?(?:dat hang|dat mon|dat don|chot don|len don|dat|chot)(?: (?:nha|nhe|a|luon|di))*$/;
const CLEAR_CART = /^(?:xoa|huy|bo|lam trong)(?: het| toan bo| sach)? gio(?: hang)?(?: .*)?$/;
const VIEW_CART = /(?:^| )gio(?: hang)?(?: |$)/;
const MENU = /(?:^| )(?:menu|thuc don)(?: |$)/;

function tokens(text) {
  return foldText(text).replace(/[.!?,;:]+$/g, "").split(" ").filter(Boolean);
}

function stripLeadingVerbs(words) {
  let rest = words;
  let hadVerb = false;
  for (let changed = true; changed; ) {
    changed = false;
    for (const verb of LEADING_VERBS) {
      if (verb.every((w, i) => rest[i] === w) && rest.length > verb.length) {
        rest = rest.slice(verb.length);
        hadVerb = changed = true;
        break;
      }
    }
  }
  return { rest, hadVerb };
}

function stripTrailingFillers(words) {
  let rest = words;
  while (rest.length > 1 && TRAILING_FILLERS.has(rest[rest.length - 1])) rest = rest.slice(0, -1);
  return rest;
}

// Pulls a leading or trailing quantity ("2 ly cà phê", "cà phê 2 ly").
// `numberWords`: whether a leading number WORD counts as a quantity — the
// caller tries both readings, since "hai" is also "hải" in "hải sản".
function splitQuantity(words, { numberWords }) {
  let rest = words;
  let quantity = null;
  const leading = rest[0];
  if (/^\d{1,4}$/.test(leading)) quantity = Number(leading);
  else if (numberWords && NUMBER_WORDS[leading] !== undefined && rest.length > 1) quantity = NUMBER_WORDS[leading];
  if (quantity !== null) {
    rest = rest.slice(1);
    if (UNITS.has(rest[0]) && rest.length > 1) rest = rest.slice(1);
  } else {
    if (UNITS.has(rest[0]) && rest.length > 1) rest = rest.slice(1);
    const n = rest.length;
    if (n >= 3 && UNITS.has(rest[n - 1]) && /^\d{1,4}$/.test(rest[n - 2])) {
      quantity = Number(rest[n - 2]);
      rest = rest.slice(0, n - 2);
    } else if (n >= 2 && /^\d{1,4}$/.test(rest[n - 1])) {
      quantity = Number(rest[n - 1]);
      rest = rest.slice(0, n - 1);
    }
  }
  return { phrase: rest.join(" "), quantity };
}

const containsPhrase = (haystack, needle) => ` ${haystack} `.includes(` ${needle} `);

// 3: the phrase IS the dish name or one of its keywords; 2: the phrase is
// part of the name ("cà phê" of "Cà Phê Đen"); 1: the phrase contains the
// name or a keyword plus extra words ("cà phê đen nóng").
function scoreProduct(phrase, product) {
  const name = foldText(product.name);
  const keywords = (product.keywords || []).map(foldText).filter(Boolean);
  if (phrase === name || keywords.includes(phrase)) return 3;
  if (containsPhrase(name, phrase)) return 2;
  if (containsPhrase(phrase, name) || keywords.some((k) => containsPhrase(phrase, k))) return 1;
  return 0;
}

function bestMatches(phrase, products) {
  if (phrase.length < 2 || !/[a-z]/.test(phrase)) return { score: 0, products: [] };
  let score = 0;
  let matched = [];
  for (const product of products) {
    const s = scoreProduct(phrase, product);
    if (s > score) {
      score = s;
      matched = [product];
    } else if (s === score && s > 0) {
      matched.push(product);
    }
  }
  return { score, products: matched };
}

/**
 * @param {string} text the customer's message
 * @param {Array<{id, name, keywords}>} products this merchant's products (including unavailable ones)
 * @returns {{type: "menu"|"view_cart"|"clear_cart"|"place_order"|"add"|"ambiguous"|"which_item"|"unknown_item"|"help", product?, products?, quantity?}}
 */
export function parseGenericOrderMessage(text, products) {
  const words = tokens(text);
  const folded = words.join(" ");
  if (folded === "") return { type: "help" };
  if (PLACE_ORDER.test(folded)) return { type: "place_order" };
  if (CLEAR_CART.test(folded)) return { type: "clear_cart" };
  if (VIEW_CART.test(folded)) return { type: "view_cart" };
  if (MENU.test(folded)) return { type: "menu" };

  const { rest, hadVerb } = stripLeadingVerbs(stripTrailingFillers(words));
  // Read a leading number word both ways and keep the better dish match; a
  // tie keeps the reading without a quantity guess.
  const literal = splitQuantity(rest, { numberWords: false });
  const counted = splitQuantity(rest, { numberWords: true });
  const a = { ...literal, ...bestMatches(literal.phrase, products) };
  const b = { ...counted, ...bestMatches(counted.phrase, products) };
  const reading = b.score > a.score ? b : a;
  const quantity = reading.quantity ?? 1;

  if (reading.products.length === 1) return { type: "add", product: reading.products[0], quantity };
  if (reading.products.length > 1) return { type: "ambiguous", products: reading.products, quantity };

  const phraseWords = reading.phrase.split(" ").filter((w) => !UNITS.has(w));
  const wantsToAdd = hadVerb || reading.quantity !== null;
  if (wantsToAdd && (phraseWords.length === 0 || phraseWords.every((w) => DEICTIC.has(w)))) return { type: "which_item" };
  if (wantsToAdd) return { type: "unknown_item" };
  return { type: "help" };
}
