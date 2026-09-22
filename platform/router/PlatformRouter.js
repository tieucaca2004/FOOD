import { classifyConciergeIntent } from "../nlp/concierge.js";

function formatMerchantCard({ merchant, matches }) {
  const itemLines = matches
    .slice(0, 5)
    .map((m) => `🍜 ${m.name}${m.available ? "" : " (tạm hết)"}`);
  const location = merchant.address ? `📍 ${merchant.address}` : "📍 (chưa có địa chỉ)";
  return [merchant.name.toUpperCase(), ...itemLines, location, `[ XEM ${merchant.name.toUpperCase()} ]`].join("\n");
}

function formatSearchResults({ organic, sponsored }) {
  if (organic.length === 0 && sponsored.length === 0) {
    return "Dạ em chưa tìm thấy quán nào phù hợp, anh/chị thử mô tả món khác giúp em nha.";
  }
  const blocks = [...organic, ...sponsored.map((s) => ({ ...s, isSponsored: true }))].map((c) =>
    c.isSponsored ? `[Được quảng bá]\n${formatMerchantCard(c)}` : formatMerchantCard(c)
  );
  return `Em tìm thấy một số quán phù hợp:\n\n${blocks.join("\n\n---\n\n")}\n\nAnh/chị muốn xem quán nào ạ?`;
}

function formatMenuSummary(menu) {
  const lines = menu.items.map((i) => `🍜 ${i.name}: ${Number(i.price).toLocaleString("vi-VN")}đ${i.available ? "" : " (tạm hết)"}`);
  return `Đã mở ${menu.name}${menu.address ? ` — 📍 ${menu.address}` : ""}\n\n${lines.join(
    "\n"
  )}\n\nAnh/chị muốn đặt món gì ạ? (Gõ "quay lại tổng đài" để tìm quán khác)`;
}

export class PlatformRouter {
  constructor({ services, discovery, merchantRouter, ai }) {
    this.services = services;
    this.discovery = discovery;
    this.merchantRouter = merchantRouter;
    this.ai = ai;
  }

  async handle({ customer, session, text }) {
    const concierge = classifyConciergeIntent(text);

    if (session.context === "merchant" && session.active_merchant_id) {
      return this._handleWithinMerchant(customer, session, text, concierge);
    }
    return this._handleAtPlatform(customer, session, text, concierge);
  }

  async _handleWithinMerchant(customer, session, text, concierge) {
    if (concierge.intent === "return_to_platform") {
      const updated = this.services.sessions.returnToPlatform(session.id);
      return { replyText: "Đã quay lại Tổng Đài, anh/chị muốn tìm quán hoặc món gì ạ?", session: updated };
    }

    if (concierge.intent === "global_search") {
      const updated = this.services.sessions.returnToPlatform(session.id);
      const query = session.last_search_query;
      if (!query) {
        return { replyText: "Anh/chị muốn tìm món gì để em tìm quán khác giúp ạ?", session: updated };
      }
      return this._runSearch(customer, updated, query);
    }

    // Everything else while inside a merchant context is scoped to that
    // merchant — never re-run a platform-wide search behind the customer's
    // back (spec §10).
    const result = await this.merchantRouter.routeMessage(session.active_merchant_id, customer.id, text);
    if (!result.ok) {
      const updated = this.services.sessions.returnToPlatform(session.id);
      return { replyText: "Quán này hiện không khả dụng, anh/chị tìm quán khác giúp em nha.", session: updated };
    }
    return {
      replyText: result.replyText,
      session,
      merchantIntent: result.merchantIntent,
      orderRef: result.orderRef,
      activeMerchantId: session.active_merchant_id,
    };
  }

  async _handleAtPlatform(customer, session, text, concierge) {
    if (concierge.intent === "greeting") {
      return { replyText: this._greetingText(), session };
    }

    if (concierge.intent === "open_merchant_by_name") {
      // Look up by name across ALL statuses first, so an existing-but-
      // unavailable merchant gets an honest "not available" reply instead
      // of silently falling through to a generic keyword search.
      const anyStatusMatches = this.discovery.repos.merchants.findByNameFragment(concierge.merchantNameHint);
      const discoverableMatches = anyStatusMatches.filter((m) => this.merchantRouter.isRoutable(m));

      if (discoverableMatches.length === 1) {
        return this._openMerchant(customer, session, discoverableMatches[0], { entrySource: "name_lookup" });
      }
      if (discoverableMatches.length > 1) {
        const cards = discoverableMatches.map((m) => `- ${m.name}`).join("\n");
        return { replyText: `Có ${discoverableMatches.length} quán tên gần giống, anh/chị chọn giúp em:\n${cards}`, session };
      }
      if (anyStatusMatches.length > 0) {
        return { replyText: `Dạ ${anyStatusMatches[0].name} hiện không khả dụng, anh/chị tìm quán khác giúp em nha.`, session };
      }
      // No merchant by that name at all — fall back to treating it as a product/category search.
      return this._runSearch(customer, session, concierge.merchantNameHint);
    }

    if (concierge.intent === "search_food") {
      return this._runSearch(customer, session, concierge.searchKeywords);
    }

    if (concierge.intent === "global_search") {
      return { replyText: "Anh/chị muốn tìm món gì ạ?", session };
    }

    // Unknown: try the optional AI fallback (never authoritative — its
    // suggestion still goes through the same DB search/resolve below).
    const aiHint = await this.ai.classify(text);
    if (aiHint?.intent === "open_merchant_by_name" && aiHint.merchantNameHint) {
      const matches = this.discovery.searchByMerchantName(aiHint.merchantNameHint);
      if (matches.length === 1) return this._openMerchant(customer, session, matches[0], { entrySource: "ai_hint" });
    }
    if (aiHint?.intent === "search_food" && aiHint.searchKeywords) {
      return this._runSearch(customer, session, aiHint.searchKeywords);
    }

    return { replyText: "Dạ em chưa rõ ý anh/chị, anh/chị muốn ăn gì hoặc tìm quán nào ạ?", session };
  }

  async _runSearch(customer, session, keywords) {
    const { organic, sponsored } = await this.discovery.searchByKeywords(keywords);
    const updated = this.services.sessions.update(session.id, {
      lastSearchQuery: keywords,
      lastSearchResults: [...organic, ...sponsored].map((c) => ({ merchant_id: c.merchant.merchant_id, name: c.merchant.name })),
    });
    return { replyText: formatSearchResults({ organic, sponsored }), session: updated, searchResultCount: organic.length + sponsored.length };
  }

  async _openMerchant(customer, session, merchant, { entrySource }) {
    if (!this.merchantRouter.isRoutable(merchant)) {
      return { replyText: `Dạ ${merchant.name} hiện không khả dụng, anh/chị tìm quán khác giúp em nha.`, session };
    }
    const adapter = this.merchantRouter.registry.getAdapter(merchant.merchant_id);
    const updated = this.services.sessions.enterMerchantContext(session.id, merchant.merchant_id, {
      entrySource,
      searchQuery: session.last_search_query,
    });
    const menu = await adapter.getMenuSummary();
    return { replyText: formatMenuSummary(menu), session: updated, openedMerchantId: merchant.merchant_id };
  }

  _greetingText() {
    return [
      "Dạ em chào anh/chị, em là trợ lý của TỔNG ĐÀI — nơi tìm và đặt món từ nhiều quán ăn qua Zalo.",
      "Anh/chị muốn ăn gì hôm nay ạ? (VD: \"Tôi muốn ăn hủ tiếu xào\")",
    ].join("\n");
  }
}
