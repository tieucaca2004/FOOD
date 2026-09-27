import { nfc, normalizeName } from "./text.js";

// Name-level structure of dishes, computed from NAMES only — never a fact
// about what is in a dish:
//   - lexical family: the head word(s) of the name ("Bún bò Huế" -> bún,
//     "Bánh canh chả cá" -> bánh canh). A family is a way to browse names
//     ("các món bún"), NOT a food entity: "bánh" is not one dish.
//   - regional name: a registered region written in the name after the head
//     ("Hủ tiếu Nam Vang" -> Phnom Penh, "Nem nướng Nha Trang" -> Nha Trang).
//     That is the dish's STYLE / name, never where a merchant is.
//   - name overlaps between two entities ("Bún bò" / "Bún bò Huế"): only
//     CANDIDATES for a person — nothing is merged here.

const lower = (s) => nfc(String(s)).toLowerCase().replace(/\s+/g, " ").trim();
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const wordRe = (text) => new RegExp(`(?<![\\p{L}\\p{N}])${escape(text)}(?![\\p{L}\\p{N}])`, "u");

export class DishFamilies {
  /** @param {import("./taxonomy.js").FoodTaxonomy} taxonomy families = lexical_family nodes (label_vi is the word) */
  constructor(taxonomy) {
    this.heads = taxonomy.json.facets.lexical_family.nodes
      .map((n) => ({ key: n.key, word: lower(n.label_vi), folded: normalizeName(n.label_vi) }))
      .sort((a, b) => b.word.length - a.word.length);
  }

  /** The longest family head the name starts with (accents respected when the name has them). */
  familyOf(name) {
    const n = lower(name);
    const f = normalizeName(name);
    const accented = n !== f;
    for (const h of this.heads) {
      const [hay, head] = accented ? [n, h.word] : [f, h.folded];
      if (hay === head || hay.startsWith(`${head} `)) return h.key;
    }
    return null;
  }

  /**
   * Regions written in a dish name after its first word.
   * @param {string} name
   * @param {{id: string, names: string[]}[]} regions
   */
  regionsInName(name, regions) {
    const n = lower(name);
    const rest = n.slice(n.indexOf(" ") + 1);
    if (!n.includes(" ")) return [];
    const out = [];
    for (const r of regions) {
      const hit = r.names.map(lower).sort((a, b) => b.length - a.length).find((rn) => wordRe(rn).test(rest));
      if (hit) out.push({ regionId: r.id, text: hit });
    }
    return out;
  }
}

/**
 * Pairs of food entities whose names overlap. Never a merge — a candidate
 * with the reason, for a person to decide (same dish / variant / distinct).
 * @param {{id: number, key: string, names: string[]}[]} entities
 * @param {{id: string, names: string[]}[]} regions
 * @returns {{a: number, b: number, kind: string, signals: object, score: number}[]}
 */
export function nameOverlapCandidates(entities, regions = []) {
  const out = new Map();
  // accent-SENSITIVE: "Phở" and "Phớ" are different names (unaccented search forms are not names here)
  const key = (s) => lower(s).replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const regionWords = regions.flatMap((r) => r.names.map((n) => ({ id: r.id, n: key(n) })));
  const put = (x, y, kind, signals, score) => {
    const [a, b] = x.id < y.id ? [x, y] : [y, x];
    const k = `${a.id}:${b.id}`;
    if (!out.has(k) || out.get(k).score < score) out.set(k, { a: a.id, b: b.id, kind, signals: { a: a.key, b: b.key, ...signals }, score });
  };
  for (const x of entities) {
    for (const y of entities) {
      if (x.id === y.id) continue;
      for (const nx of x.names.map(key)) {
        for (const ny of y.names.map(key)) {
          if (!nx || !ny) continue;
          if (nx === ny) {
            // names[0] is the canonical name: equal canonicals = same_name, else an alias is shared
            const bothCanonical = nx === key(x.names[0]) && ny === key(y.names[0]);
            if (x.id < y.id) put(x, y, bothCanonical ? "same_name" : "shared_name", { name: nx }, 0.9);
          } else if (ny.startsWith(`${nx} `)) {
            // y's name = x's name + more words
            const extra = ny.slice(nx.length + 1);
            const region = regionWords.find((r) => r.n === extra);
            if (region) put(x, y, "regional_style_of", { base: nx, extended: ny, region: region.id }, 0.7);
            else put(x, y, "name_extends", { base: nx, extended: ny, extra }, 0.5);
          }
        }
      }
    }
  }
  return [...out.values()];
}
