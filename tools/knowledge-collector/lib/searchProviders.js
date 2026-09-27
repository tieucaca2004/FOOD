// Search-result discovery goes ONLY through an official search API. The
// collector never requests a search engine's result pages (Google's
// robots.txt disallows /search for crawlers; the fetcher also refuses them).
//
// GoogleProgrammableSearch uses the Custom Search JSON API
// (https://www.googleapis.com/customsearch/v1) and needs GOOGLE_CSE_KEY +
// GOOGLE_CSE_CX. Without them discovery is skipped — reported, not faked.

export class GoogleProgrammableSearch {
  constructor({ key = process.env.GOOGLE_CSE_KEY, cx = process.env.GOOGLE_CSE_CX, fetchImpl = globalThis.fetch } = {}) {
    this.key = key;
    this.cx = cx;
    this.fetchImpl = fetchImpl;
  }

  get configured() {
    return Boolean(this.key && this.cx);
  }

  /** @returns {Promise<{skipped?: string, results?: Array<{url, title, snippet}>}>} */
  async search(query, { num = 10, lang = "lang_vi" } = {}) {
    if (!this.configured) return { skipped: "NO_API_KEY" };
    const url = new URL("https://www.googleapis.com/customsearch/v1");
    url.search = new URLSearchParams({ key: this.key, cx: this.cx, q: query, num: String(num), lr: lang }).toString();
    const res = await this.fetchImpl(url.toString(), { headers: { accept: "application/json" } });
    if (!res.ok) return { skipped: `HTTP_${res.status}` };
    const data = await res.json();
    return { results: (data.items || []).map((i) => ({ url: i.link, title: i.title, snippet: i.snippet })) };
  }
}
