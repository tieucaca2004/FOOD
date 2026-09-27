import { formatVnd } from "../domain/money.js";

function stripAccents(text) {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/gi, "d")
    .toLowerCase();
}

const words = (text) => String(text || "").normalize("NFC").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
const hasMarks = (word) => stripAccents(word) !== word;
// words that name nothing (accent-free): quantity, container, order / cart verbs, question and polite words
const FILLER = new Set(
  (
    "co khong ko k hong cho toi minh em anh chi tui ban mot hai ba bon nam sau bay tam chin muoi chuc to phan dia ly suat cai goi " +
    "dat them lay mua an muon can gia bao nhieu tien voi nhe nha a oi di nua con xoa bo doi sua thanh huy ra khoi gio mon xem " +
    "chi tiet la gi sao the nao vay roi duoc het ah uh nua thoi"
  ).split(" ")
);

export class MenuService {
  constructor(repos) {
    this.repos = repos;
  }

  listMenu() {
    return this.repos.products.list();
  }

  getProductById(id) {
    return this.repos.products.findById(id);
  }

  listByCategory(categoryName) {
    return this.repos.products.listByCategoryName(categoryName);
  }

  // Matches free text against every available product's keywords/name.
  // Returns { exact: Product|null, candidates: Product[] } — never invents
  // a product; only ever returns rows that exist in the products table.
  //
  // Whole words only (a keyword or the name must appear as a word sequence), accents the customer TYPED must be
  // the product's own ("bơ"/"bỏ" are not "bò"), and a ONE-word keyword ("bo") counts only when every other word
  // of the message is filler (quantity, container, order / question / polite words). A plain substring of the
  // accent-free text used to match "Bún bò Huế đó", "combo", "bánh bò" to Hủ Tiếu Xào Bò (Phase 1.5, live
  // Telegram 2026-09-26). The result is a subset of the old matches: only false matches are removed.
  findProductMatches(text) {
    const typed = words(text);
    const keys = typed.map(stripAccents);
    const products = this.repos.products.list({ includeUnavailable: true });

    const scored = products.filter((p) => {
      const accented = new Map(words(p.name).map((w) => [stripAccents(w), w])); // "bo" -> "bò"
      const at = (phrase) => {
        for (let i = 0; i + phrase.length <= keys.length; i++) {
          if (!phrase.every((w, j) => keys[i + j] === w)) continue;
          if (phrase.every((w, j) => !hasMarks(typed[i + j]) || !accented.has(w) || accented.get(w) === typed[i + j])) return i;
        }
        return -1;
      };
      return [...p.keywords, p.name].some((k) => {
        const phrase = stripAccents(k).split(/[^a-z0-9]+/).filter(Boolean);
        if (!phrase.length) return false;
        const i = at(phrase);
        if (i < 0) return false;
        if (phrase.length > 1) return true;
        return keys.every((w, j) => j === i || FILLER.has(w) || /^\d+$/.test(w));
      });
    });

    if (scored.length === 1) return { exact: scored[0], candidates: [] };
    if (scored.length > 1) return { exact: null, candidates: scored };
    return { exact: null, candidates: [] };
  }

  formatMenuText() {
    const products = this.listMenu();
    if (products.length === 0) return "Dạ hiện menu đang được cập nhật, anh/chị vui lòng quay lại sau nha.";
    const lines = products.map((p) => `- ${p.name}: ${formatVnd(p.price)}`);
    return `Dạ đây là menu hiện có:\n${lines.join("\n")}`;
  }

  formatProductDetail(product) {
    if (!product.available) {
      return `${product.name} hiện đang tạm hết, anh/chị chọn món khác giúp em nha.`;
    }
    return `${product.name}: ${formatVnd(product.price)}${product.description ? ` — ${product.description}` : ""}`;
  }
}
