import { formatVnd } from "../domain/money.js";

function stripAccents(text) {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/gi, "d")
    .toLowerCase();
}

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
  findProductMatches(text) {
    const normalized = stripAccents(text || "");
    const products = this.repos.products.list({ includeUnavailable: true });

    const scored = products
      .map((p) => {
        const tokens = [...p.keywords, p.name].map(stripAccents);
        const hit = tokens.some((t) => normalized.includes(t));
        return { product: p, hit };
      })
      .filter((x) => x.hit)
      .map((x) => x.product);

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
