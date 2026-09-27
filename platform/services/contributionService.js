import { fold } from "../conversation/understand.js";
import { minimisedRaw } from "../channel/inboundMessage.js";

// ContributionService — the ONE entry for customer knowledge contributions (Multimodal Knowledge Ingestion V1).
//
// It sits IN FRONT of the router (wrapRouter) and only acts on:
//   - an image (or unsupported media) from the chat          -> evidence + reading + the pending submission;
//   - the customer's answer while THEIR submission waits     -> merchant / confirmation / cancel;
//   - a text that the deterministic rules call a contribution ("Quán ABC bán bánh hỏi 40k");
//   - after the router answered a price / menu question      -> appends labelled USER_CONTRIBUTED_UNVERIFIED_EVIDENCE.
// Everything else goes to PlatformRouter unchanged (Search V2, GPT, merchant / cart / order / checkout untouched).
// The pending state lives on the submission (knowledge DB), never in the platform session or ordering state.
// It never writes the catalog, a price, orderability, a cart or an order; candidates wait for a person.

const vnd = (n) => `${Number(n).toLocaleString("vi-VN")}đ`;
const ddmm = (iso) => {
  const d = new Date(String(iso).includes("T") ? iso : `${String(iso).replace(" ", "T")}Z`);
  return Number.isNaN(d.getTime()) ? "" : `${String(d.getUTCDate()).padStart(2, "0")}/${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
};
const TYPE_LABEL = { MENU: "menu", PRICE_BOARD: "bảng giá", MERCHANT_SIGN: "biển hiệu quán", ADDRESS: "địa chỉ quán", FOOD_PHOTO: "ảnh món ăn", BUSINESS_CARD: "danh thiếp", RECEIPT: "hoá đơn", GENERAL_FOOD: "ảnh về món ăn", UNKNOWN: "ảnh" };
const PRICE_QUESTION = /(giá|gia\s|bao nhiêu|bao nhieu|menu|thực đơn|thuc don|có món|món gì|mon gi|bán gì|ban gi|mấy tiền|may tien)/iu;
const ASK_CHOICE = "Trả lời “có” / “lưu” để lưu, hoặc “không” / “bỏ qua”.";
const UNSUPPORTED = "Dạ hiện em chỉ đọc được ảnh (JPG / PNG) và tin nhắn chữ ạ.";
const DAY_MS = 86_400_000;
// words of a price / menu question that are not the dish ("giá bún bò bao nhiêu" -> bún bò)
const QUESTION_WORDS = new Set("gia bao nhieu bn the nao quan mon co khong ko k may tien menu thuc don a ban oi vay la mot to dia phan cho em anh chi minh o day do nay kia hien nay hom nua sao".split(" "));

const norm = (s) => fold(String(s ?? "")).folded.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const stripPlace = (s) => norm(String(s ?? "").replace(/^\s*\[[^\]]*\]\s*/, "")).replace(/^(?:quan|tiem|nha hang|hang)\s+/, "");

export class ContributionService {
  /**
   * @param {{ingest: object, services: object, repos: object, foodKnowledge?: object|null, send?: Function|null, logger?: object|null,
   *          maxImagesPerDay?: number, coalesceMs?: number, background?: boolean, now?: () => Date}} deps
   */
  constructor({ ingest, services, repos, foodKnowledge = null, send = null, logger = null, maxImagesPerDay = 20, maxImagesPerAlbum = 5, coalesceMs = 1500, background = true, now = () => new Date() }) {
    this.ingest = ingest;
    this.store = ingest.store;
    this.hasher = ingest.hasher;
    this.services = services;
    this.repos = repos;
    this.foodKnowledge = foodKnowledge;
    this.sendImpl = send;
    this.logger = logger;
    this.maxImagesPerDay = maxImagesPerDay;
    this.maxImagesPerAlbum = maxImagesPerAlbum;
    this.coalesceMs = coalesceMs;
    this.background = background;
    this.now = now;
    this._timers = new Map();
    this._jobs = new Set();
  }

  /** The router as the channels see it: same interface; contribution turns are answered here, the rest passes. */
  wrapRouter(router) {
    const svc = this;
    return new Proxy(router, {
      get(target, prop, receiver) {
        if (prop === "handle") return (req) => svc.handle(req, target);
        const v = Reflect.get(target, prop, receiver);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
  }

  /** Resolves when every scheduled background reading has finished (tests / shutdown). */
  async idle() {
    while (this._timers.size || this._jobs.size) {
      for (const [id, t] of this._timers) {
        clearTimeout(t.timer);
        this._timers.delete(id);
        this._track(this._process(id, t.target));
      }
      await Promise.all([...this._jobs]);
    }
  }

  identity(customer, inbound) {
    if (inbound) return { channel: inbound.channel, userId: inbound.externalUserId, chatId: inbound.externalChatId };
    const z = String(customer?.zalo_user_id ?? "");
    if (z.startsWith("telegram:")) return { channel: "telegram", userId: z.slice(9), chatId: z.slice(9) };
    if (!z || z.includes(":")) return null; // bridged / synthetic ids never contribute
    return { channel: "zalo", userId: z, chatId: z };
  }

  async handle(req, router) {
    const { customer, session, text, inbound = null } = req;
    const who = this.identity(customer, inbound);
    if (inbound && (inbound.attachments?.length || inbound.unsupported)) {
      if (!who) return { replyText: null, session };
      try {
        return await this._onMedia({ session, inbound, who });
      } catch (err) {
        this._warn("media contribution failed", err);
        return { replyText: "Dạ em chưa nhận được ảnh này, bạn gửi lại giúp em nhé.", session, contribution: { status: "error" } };
      }
    }
    if (who && typeof text === "string" && text.trim()) {
      try {
        const r = await this._onText({ session, text, who });
        if (r) return r;
      } catch (err) {
        this._warn("text contribution failed", err); // never blocks the normal conversation
      }
    }
    const result = await router.handle({ customer, session, text });
    if (!who) return result;
    try {
      return this._decorate(result, { session, text, who });
    } catch (err) {
      this._warn("contribution retrieval failed", err);
      return result;
    }
  }

  // ------------------------------------------------------------------ media

  async _onMedia({ session, inbound, who }) {
    if (!inbound.attachments.length) return { replyText: UNSUPPORTED, session, contribution: { status: "unsupported", kind: inbound.unsupported } };
    const senderHash = this.hasher.user(who.channel, who.userId);
    const since = new Date(this.now().getTime() - DAY_MS).toISOString();
    if (this.store.imagesSince(who.channel, senderHash, since) + inbound.attachments.length > this.maxImagesPerDay) {
      return { replyText: "Dạ hôm nay bạn đã gửi nhiều ảnh rồi, em tạm chưa nhận thêm. Mai bạn gửi tiếp giúp em nhé.", session, contribution: { status: "rate_limited" } };
    }
    let s = this.store.open(who.channel, senderHash);
    const albumSoFar = s && inbound.mediaGroupId ? this.store.messages(s.id).filter((m) => m.media_group_id === inbound.mediaGroupId).length : 0;
    const sameAlbum = albumSoFar > 0;
    // an album beyond the cap: the extra images are not stored (the first ones are read as usual), no extra reply
    if (albumSoFar >= this.maxImagesPerAlbum) return { replyText: null, session, contribution: { status: "album_limit", submissionId: s.id } };
    if (s && s.status !== "EXTRACTING" && s.status !== "RECEIVED") s = this.store.transition(s.id, "EXTRACTING", { actor: "customer", reason: "more_media" });
    if (!s) {
      s = this.store.create({ channel: who.channel, senderHash, kid: this.hasher.kid, sessionRef: session?.id ?? null });
      s = this.store.transition(s.id, "EXTRACTING", { actor: "system", reason: "media_received" });
    } else if (s.status === "RECEIVED") s = this.store.transition(s.id, "EXTRACTING", { actor: "system", reason: "media_received" });
    const r = this.store.addMessage(s, {
      chatId: this.hasher.chat(who.channel, who.chatId),
      messageId: inbound.messageId,
      updateId: inbound.updateId,
      sentAt: inbound.timestamp ? new Date(inbound.timestamp * (inbound.timestamp < 1e12 ? 1000 : 1)).toISOString() : null,
      caption: inbound.text,
      mediaGroupId: inbound.mediaGroupId,
      media: inbound.attachments.map((a) => ({ type: "photo", fileId: a.ref, mimeType: a.mimeType })),
      raw: minimisedRaw(inbound),
    });
    if (r.status === "duplicate") return { replyText: null, session, contribution: { status: "duplicate", submissionId: s.id } };
    this._log("image received", { submissionId: s.id, channel: who.channel, images: inbound.attachments.length });
    this._schedule(s.id, { ...who, sessionId: session?.id ?? null });
    const reply = sameAlbum ? null : this.ingest.readers.ocr ? "Dạ em đã nhận ảnh, đang đọc nội dung — em báo lại ngay ạ." : "Dạ em đã nhận ảnh và lưu lại làm tư liệu ạ.";
    return { replyText: reply, session, contribution: { status: "received", submissionId: s.id } };
  }

  _schedule(id, target) {
    const existing = this._timers.get(id);
    if (existing) clearTimeout(existing.timer);
    const timer = setTimeout(() => {
      this._timers.delete(id);
      this._track(this._process(id, target));
    }, this.coalesceMs);
    timer.unref?.();
    this._timers.set(id, { timer, target });
  }

  _track(p) {
    const job = p.catch((err) => this._warn("background contribution failed", err)).finally(() => this._jobs.delete(job));
    this._jobs.add(job);
    return job;
  }

  async _process(id, target) {
    await this.ingest.drain();
    const s = this.store.get(id);
    if (s?.status !== "EXTRACTING") return;
    const p = this.store.progress(id);
    if (p.pending) {
      // a reader failed for now and will be retried (backoff): tell the customer once, try again later
      await this._send(target, "Dạ em đang gặp trục trặc khi đọc ảnh, em sẽ thử lại và báo bạn sau ạ.");
      const retry = setTimeout(() => this._track(this._process(id, target)), 2 * 60_000);
      retry.unref?.();
      return;
    }
    const text = this._afterExtraction(s);
    if (text) await this._send(target, text);
  }

  async _send(target, text) {
    if (!text || !this.sendImpl) return;
    try {
      await this.sendImpl(target, text);
    } catch (err) {
      this._warn("contribution reply send failed", err);
    }
    if (target.sessionId) {
      try {
        this.repos?.messages?.log({ sessionId: target.sessionId, direction: "out", rawText: text });
      } catch {
        /* logging a reply never breaks the flow */
      }
    }
  }

  // what was read -> ask for the merchant / the confirmation, or say nothing useful was found
  _afterExtraction(s) {
    const reading = this.store.reading(s.id);
    const progress = this.store.progress(s.id);
    // what the customer is shown back: never an implausible "price" (1đ, a slip) — it still goes to review
    const useful = reading.findings.filter((f) => ["price", "product", "address", "opening_hours", "availability"].includes(f.kind) && !(f.kind === "price" && f.implausible));
    const mediaCount = this.store.mediaCount(s.id);
    if (!useful.length && !reading.foods.length && !reading.places.length) {
      const fetchFailures = progress.failed.filter((f) => f.stage === "media_fetch");
      if (mediaCount && fetchFailures.length >= mediaCount) {
        this.store.transition(s.id, "FAILED", { reason: fetchFailures[0].error?.slice(0, 120) ?? "media_fetch" });
        return /image rejected|too large|not allowed/.test(fetchFailures[0].error ?? "")
          ? "Dạ ảnh này em không mở được (định dạng, dung lượng hoặc ảnh bị lỗi). Bạn gửi lại ảnh JPG / PNG rõ hơn giúp em nhé."
          : "Dạ em chưa tải được ảnh, bạn gửi lại giúp em nhé.";
      }
      if (progress.failed.some((f) => ["ocr", "vision"].includes(f.stage))) {
        this.store.transition(s.id, "FAILED", { reason: "reader_failed" });
        return "Dạ em đã lưu ảnh, nhưng hiện chưa đọc được nội dung ảnh ạ.";
      }
      this.store.transition(s.id, "NO_CONTENT", { reason: progress.waitingProvider ? "no_reader" : "nothing_found" });
      return progress.waitingProvider ? "Dạ em đã lưu ảnh làm tư liệu ạ." : "Dạ em đã lưu ảnh, nhưng chưa thấy thông tin món, giá hay tên quán trong ảnh này ạ.";
    }
    const placeText = s.place_text ?? reading.places[0]?.place ?? null;
    const place = s.place_resolution ?? this._resolvePlace(placeText);
    const label = TYPE_LABEL[reading.documentTypes[0]] ?? (mediaCount ? "ảnh" : "thông tin");
    const lines = this._summary(useful, reading.foods, placeText);
    const conflicts = this._catalogConflicts(useful, place);
    const known = place && (place.status === "resolved" || place.catalogMerchantId) && place.class !== "AMBIGUOUS";
    if (known) {
      this.store.transition(s.id, "WAITING_FOR_CONFIRMATION", {
        reason: "place_known",
        patch: { place_text: placeText, place_resolution: place, place_message_id: this.store.messages(s.id)[0].id, questions_asked: Math.min(3, s.questions_asked + 1) },
      });
      return [`Dạ ${mediaCount ? `ảnh này có vẻ là ${label}` : "em đọc được thông tin"} của ${place.name}. Đọc được:`, ...lines, ...conflicts, `Bạn có muốn lưu làm thông tin tham khảo (chưa xác minh) không ạ? ${ASK_CHOICE}`].join("\n");
    }
    this.store.transition(s.id, "WAITING_FOR_MERCHANT", { reason: place?.class === "AMBIGUOUS" ? "place_ambiguous" : "place_unknown", patch: { questions_asked: Math.min(3, s.questions_asked + 1) } });
    const which =
      place?.class === "AMBIGUOUS"
        ? `Em thấy có mấy quán tên “${placeText}”: ${place.candidates.slice(0, 3).map((c, i) => `${i + 1}) ${c.name}${c.address ? ` — ${c.address}` : ""}`).join("; ")}. Bạn ghi rõ tên quán kèm địa chỉ giúp em nhé (hoặc “bỏ qua”).`
        : "Bạn muốn lưu cho quán nào ạ? (gửi tên quán, hoặc “bỏ qua”)";
    return [`Dạ ${mediaCount ? `ảnh này có vẻ là ${label}` : "em đọc được thông tin"}. Đọc được:`, ...lines, which].join("\n");
  }

  _summary(findings, foods, placeText = null) {
    const out = [];
    for (const f of findings.slice(0, 8)) {
      if (f.kind === "price") out.push(`• ${f.productText}${f.variant ? ` (${f.variant})` : ""} — ${this._price(f.normalizedValue)}`);
      else if (f.kind === "product") out.push(`• ${f.productText} — (chưa đọc rõ giá)`);
      else if (f.kind === "address") out.push(`• Địa chỉ: ${f.rawValue}`);
      else if (f.kind === "opening_hours") out.push(`• Giờ mở cửa: ${f.rawValue}`);
      else if (f.kind === "availability") out.push(`• Ngưng bán: ${f.productText}`);
    }
    if (findings.length > 8) out.push(`• … và ${findings.length - 8} mục khác`);
    for (const g of foods.slice(0, 2)) out.push(`• Có thể là món ${g.value} (em đoán từ ảnh, chưa chắc)`);
    if (!out.length && placeText) out.push(`• Tên quán: ${placeText}`);
    return out.length ? out : ["• (không có món / giá)"];
  }

  _price(v) {
    const [a, b] = String(v).split("-").map(Number);
    return b ? `${vnd(a)}–${vnd(b)}` : vnd(a);
  }

  _catalogConflicts(findings, place) {
    if (!place?.catalogMerchantId) return [];
    const out = [];
    for (const f of findings.filter((x) => x.kind === "price")) {
      const official = this._catalogPrice(place.catalogMerchantId, f.productText);
      if (typeof official === "number" && String(official) !== f.normalizedValue) {
        out.push(`⚠️ ${f.productText}: dữ liệu menu hiện tại của quán đang ghi ${vnd(official)}, còn ảnh bạn gửi ghi ${this._price(f.normalizedValue)}.`);
      }
    }
    return out;
  }

  // ------------------------------------------------------------------ text

  async _onText({ session, text, who }) {
    const strict = session?.context === "merchant" && Boolean(session?.active_merchant_id);
    const senderHash = this.hasher.user(who.channel, who.userId);
    const s = this.store.open(who.channel, senderHash);
    const reply = (replyText, extra = {}) => ({ replyText, session, contribution: { submissionId: s?.id ?? null, ...extra } });
    if (s) {
      const r = this.ingest.classifyReply(text, { strict, expecting: s.status === "WAITING_FOR_MERCHANT" ? "merchant" : "confirmation" });
      if (r.kind === "ERASE") return reply(this._erase(who, senderHash), { status: "erased" });
      if (s.status === "EXTRACTING" || s.status === "RECEIVED") {
        // the reading is finished but was never delivered (e.g. after a restart): deliver it now
        if (s.status === "EXTRACTING" && this.store.progress(s.id).done && !this._timers.has(s.id)) {
          const pending = this._afterExtraction(s);
          if (pending) {
            const again = this.store.get(s.id);
            if (["WAITING_FOR_MERCHANT", "WAITING_FOR_CONFIRMATION"].includes(again.status) && r.kind !== "OTHER") return this._onText({ session, text, who });
            return reply(pending, { status: again.status });
          }
        }
        if (r.kind === "NO") return reply(this._cancel(s), { status: "CANCELLED" });
        if (r.kind === "PLACE") {
          const m = this._addText(s, who, text);
          this.store.transition(s.id, s.status, { actor: "customer", messageId: m, patch: { place_text: r.place, place_resolution: this._resolvePlace(r.place), place_message_id: m } });
          return reply(`Dạ em ghi nhận quán “${r.place}”, em đang đọc ảnh — xong em báo ngay ạ.`, { status: "EXTRACTING" });
        }
        return null;
      }
      if (r.kind === "NO") return reply(this._cancel(s), { status: "CANCELLED" });
      if (r.kind === "YES") {
        if (s.status === "WAITING_FOR_CONFIRMATION") return reply(await this._confirm(s, this._addText(s, who, text)), { status: "CANDIDATE" });
        return reply("Dạ bạn cho em xin tên quán nhé (hoặc “bỏ qua”).", { status: s.status });
      }
      if (r.kind === "PLACE") {
        const m = this._addText(s, who, text);
        await this.ingest.drain();
        const place = this._resolvePlace(r.place);
        if (place.class === "AMBIGUOUS" && s.questions_asked < 2) {
          this.store.transition(s.id, "WAITING_FOR_MERCHANT", { actor: "customer", messageId: m, reason: "place_ambiguous", patch: { place_text: r.place, place_resolution: place, place_message_id: m, questions_asked: s.questions_asked + 1 } });
          return reply(`Em thấy có mấy quán tên “${r.place}”: ${place.candidates.slice(0, 3).map((c, i) => `${i + 1}) ${c.name}${c.address ? ` — ${c.address}` : ""}`).join("; ")}. Bạn ghi rõ tên quán kèm địa chỉ giúp em nhé.`, { status: "WAITING_FOR_MERCHANT" });
        }
        // naming the place to save it FOR is the customer's confirmation
        this.store.transition(s.id, s.status, { actor: "customer", messageId: m, patch: { place_text: r.place, place_resolution: place, place_message_id: m } });
        return reply(await this._confirm(this.store.get(s.id), m), { status: "CANDIDATE" });
      }
      return null; // an unrelated message: the normal conversation; the submission waits (and expires)
    }
    if (strict) return null;
    if (this.ingest.classifyReply(text).kind === "ERASE") return reply(this._erase(who, senderHash), { status: "erased" });
    const c = this.ingest.classifyText(text);
    if (c.kind !== "CONTRIBUTION") return null;
    let sub = this.store.create({ channel: who.channel, senderHash, kid: this.hasher.kid, sessionRef: session?.id ?? null });
    sub = this.store.transition(sub.id, "EXTRACTING", { actor: "system", reason: "text_contribution" });
    this._addText(sub, who, text);
    await this.ingest.drain();
    this._log("text contribution", { submissionId: sub.id, channel: who.channel });
    return { replyText: this._afterExtraction(this.store.get(sub.id)), session, contribution: { submissionId: sub.id, status: this.store.get(sub.id).status } };
  }

  _addText(s, who, text) {
    const id = `t:${this.now().getTime()}:${Math.random().toString(36).slice(2, 8)}`;
    const r = this.store.addMessage(s, { chatId: this.hasher.chat(who.channel, who.chatId), messageId: id, sentAt: this.now().toISOString(), text, raw: { channel: who.channel, message: { message_id: id } } });
    return r.id;
  }

  _cancel(s) {
    this.store.transition(s.id, "CANCELLED", { actor: "customer", reason: "customer_declined" });
    return "Dạ vâng, em không lưu thông tin này ạ.";
  }

  async _confirm(s, messageId) {
    const confirmed = this.store.transition(s.id, "CANDIDATE", { actor: "customer", messageId, reason: "customer_confirmed" });
    const n = this.store.materialize(confirmed.id, { catalogPrice: (m, p) => this._catalogPrice(m, p), resolveFood: (name) => this._resolveFood(name) });
    const cands = this.store.candidates(confirmed.id);
    const place = confirmed.place_resolution;
    const where = place?.name ?? confirmed.place_text ?? null;
    this._log("contribution confirmed", { submissionId: s.id, candidates: n, placeClass: place?.class ?? "none" });
    const lines = [
      n
        ? `Dạ em đã lưu ${cands.length} thông tin${where ? ` cho ${where}` : ""} làm nguồn tham khảo (chưa xác minh). Thông tin chính thức của quán không thay đổi; FOOD sẽ kiểm tra trước khi dùng ạ.`
        : `Dạ em đã lưu ảnh làm tư liệu${where ? ` cho ${where}` : ""} ạ.`,
    ];
    for (const c of cands.filter((x) => x.change === "CONFLICT" && x.catalog_merchant_id && x.previous_value)) {
      lines.push(`Dữ liệu menu hiện tại của quán đang ghi ${this._price(c.previous_value)}, còn ${c.assertion_kind === "OBSERVED" ? "ảnh" : "tin nhắn"} bạn gửi ghi ${this._price(c.normalized_value)}. Mình đã lưu làm nguồn tham khảo nhưng chưa thay đổi giá chính thức.`);
    }
    if (!place || place.class === "NEW_MERCHANT_CANDIDATE" || place.class === "AMBIGUOUS") lines.push("(Quán này FOOD chưa có trong dữ liệu — em ghi nhận để kiểm tra.)");
    return lines.join("\n");
  }

  _erase(who, senderHash) {
    const r = this.store.erase(who.channel, senderHash);
    this._log("contributions erased", { channel: who.channel, messages: r.messages, files: r.filesPurged });
    return r.messages ? "Dạ em đã xoá ảnh và thông tin bạn gửi ạ." : "Dạ bạn chưa gửi ảnh hay thông tin nào để xoá ạ.";
  }

  // ------------------------------------------------------------------ resolution (existing data only)

  /** Place as written -> knowledge place + FOOD catalog place; never merged, never created. */
  _resolvePlace(placeText) {
    if (!placeText) return { status: "none", class: null, kbPlaceId: null, catalogMerchantId: null, candidates: [], name: null };
    const kb = this.store.resolvePlace(placeText);
    const cat = this._catalogMatch(placeText);
    const kbName = kb.candidates.find((c) => c.kbPlaceId === kb.kbPlaceId)?.name ?? null;
    const exactKb = kb.status === "resolved" && kbName && stripPlace(kbName) === stripPlace(placeText);
    const cls = cat?.exact || exactKb ? "EXACT_EXISTING_MERCHANT" : kb.status === "ambiguous" ? "AMBIGUOUS" : kb.status === "resolved" || cat ? "LIKELY_EXISTING_MERCHANT" : "NEW_MERCHANT_CANDIDATE";
    return { ...kb, class: cls, catalogMerchantId: cat?.merchant.merchant_id ?? null, name: cat?.merchant.name.replace(/^\s*\[[^\]]*\]\s*/, "") ?? kbName ?? placeText };
  }

  _catalogMatch(placeText) {
    const key = stripPlace(placeText);
    if (!key) return null;
    let list = [];
    try {
      list = this.services.merchantData.listDiscoverable();
    } catch {
      return null;
    }
    const exact = list.filter((m) => stripPlace(m.name) === key);
    if (exact.length === 1) return { merchant: exact[0], exact: true };
    if (exact.length > 1) return null;
    const words = key.split(" ");
    if (words.length < 2) return null;
    const partial = list.filter((m) => {
      const w = stripPlace(m.name).split(" ");
      return words.every((x) => w.includes(x));
    });
    return partial.length === 1 ? { merchant: partial[0], exact: false } : null;
  }

  /** The FOOD catalog (authoritative) price of a product with exactly that name, or null. */
  _catalogPrice(merchantId, productText) {
    try {
      const matches = this.services.menu.listProducts(merchantId, { includeUnavailable: true }).filter((p) => norm(p.name) === norm(productText));
      return matches.length === 1 ? matches[0].price : null;
    } catch {
      return null;
    }
  }

  /** Canonical dish through the EXISTING approved matcher (Search V2's); a typo stays a suggestion, never a match. */
  _resolveFood(name) {
    const matcher = this.foodKnowledge?.termMatcher?.() ?? this.foodKnowledge?.searchMatcher?.() ?? null;
    if (!matcher || !name) return null;
    const r = matcher.match(String(name));
    const m = (r.matches ?? []).find((x) => !x.typo && norm(x.text) === norm(name));
    if (!m || !this.store.hasFood(m.foodEntityId)) return null;
    return { foodEntityId: m.foodEntityId, canonicalName: m.canonicalName };
  }

  _foodsIn(text) {
    const matcher = this.foodKnowledge?.termMatcher?.() ?? this.foodKnowledge?.searchMatcher?.() ?? null;
    if (!matcher) return { ids: [], names: [] };
    const r = matcher.match(String(text));
    return { ids: [...new Set((r.matches ?? []).filter((m) => !m.typo).map((m) => m.foodEntityId))], names: (r.matches ?? []).map((m) => m.text) };
  }

  // ------------------------------------------------------------------ retrieval (deterministic path)

  /**
   * After the router answered: for a price / menu question, add what customers contributed — labelled
   * USER_CONTRIBUTED_UNVERIFIED_EVIDENCE, after the authoritative / published answer, never instead of it.
   */
  _decorate(result, { session, text, who }) {
    const current = result?.session ?? session;
    if (!result?.replyText || current?.context === "merchant" || !PRICE_QUESTION.test(String(text ?? ""))) return result;
    if (/chưa xác minh/u.test(result.replyText)) return result;
    const rows = this.contributionsFor({ text, session: current, senderHash: this.hasher.user(who.channel, who.userId), limit: 3 });
    if (!rows.length) return result;
    const block = ["ℹ️ Thông tin khách hàng cung cấp — chưa xác minh:", ...rows.map((r) => this.renderLine(r))].join("\n");
    return { ...result, replyText: `${result.replyText}\n\n${block}`, contributionsShown: rows.length };
  }

  /**
   * Visible candidates for a question: the customer's own first, then those of the places the conversation shows.
   * Authoritative data wins: a candidate for a catalog product that has a catalog price is not shown to others.
   */
  contributionsFor({ text = "", session = null, senderHash = null, merchantIds = [], field = null, limit = 5 }) {
    const foods = this._foodsIn(text);
    const words = norm(text).split(" ").filter((w) => w.length > 1);
    let kbIds = merchantIds.map((id) => Number(String(id).replace(/^kb:/, ""))).filter(Number.isFinite);
    const catIds = merchantIds.filter((id) => String(id).startsWith("cat:")).map((id) => String(id).slice(4));
    if (!kbIds.length && !catIds.length) {
      try {
        const ctx = session?.knowledge_context_json ? JSON.parse(session.knowledge_context_json) : null;
        kbIds = (ctx?.matchedIds ?? []).slice(0, 30).map(Number).filter(Number.isFinite);
      } catch {
        kbIds = [];
      }
    }
    const nameFilter = foods.ids.length ? [] : foods.names;
    const seen = new Set();
    const pick = (rows) => rows.filter((r) => !seen.has(r.candidate_id) && seen.add(r.candidate_id));
    const own = senderHash && (foods.ids.length || foods.names.length) ? pick(this.store.visible({ foodEntityIds: foods.ids, names: nameFilter, field, senderHash, ownOnly: true, limit })) : [];
    const scoped = kbIds.length || catIds.length ? pick(this.store.visible({ kbMerchantIds: kbIds, catalogMerchantIds: catIds, foodEntityIds: foods.ids, names: nameFilter, field, senderHash, limit })) : [];
    // no dish recognised in the question: an own contribution matches on its written dish name
    const dishWords = words.filter((w) => !QUESTION_WORDS.has(w));
    const ownByWords =
      !foods.ids.length && senderHash && dishWords.length
        ? pick(
            this.store.visible({ field, senderHash, ownOnly: true, limit: 20 }).filter((r) => {
              const name = norm(r.name_as_written ?? "").split(" ").filter(Boolean);
              return name.length && (dishWords.every((w) => name.includes(w)) || name.every((w) => dishWords.includes(w)));
            })
          )
        : [];
    return [...own, ...ownByWords, ...scoped]
      .filter((r) => r.own_contribution || !(r.catalog_merchant_id && r.name_as_written && typeof this._catalogPrice(r.catalog_merchant_id, r.name_as_written) === "number"))
      .slice(0, limit);
  }

  /** One customer-facing line (rendered by the backend; the model never formats a candidate value). */
  renderLine(r) {
    const what = r.media_type === "TEXT" ? "tin nhắn" : "ảnh";
    const value = r.field === "price" ? this._price(r.value) : r.field === "product" ? "có trong menu" : r.field === "address" ? `địa chỉ: ${r.raw_value}` : r.field === "opening_hours" ? `giờ mở cửa: ${r.raw_value}` : r.field === "dish" ? "(món đoán từ ảnh)" : r.raw_value;
    const place = r.place_as_written ? ` — ${r.place_as_written}` : "";
    const item = r.name_as_written ? `${r.name_as_written} ${value}` : value;
    return r.own_contribution ? `• ${what === "ảnh" ? "Ảnh" : "Tin nhắn"} bạn gửi (${ddmm(r.captured_at)}) có ghi ${item}${place}` : `• Theo ${what} một khách gửi ngày ${ddmm(r.captured_at)}: ${item}${place}`;
  }

  /** Tool-shaped records for the GPT concierge (USER_CONTRIBUTED_UNVERIFIED_EVIDENCE; no identity, no raw text). */
  forModel(rows) {
    return rows.map((r) => ({
      contribution_id: `ic:${r.candidate_id}`,
      knowledge_kind: "USER_CONTRIBUTED_UNVERIFIED_EVIDENCE",
      verified: false,
      status: "CANDIDATE",
      entity: { merchant_id: r.kb_merchant_id ? `kb:${r.kb_merchant_id}` : r.catalog_merchant_id ? `cat:${r.catalog_merchant_id}` : null, place_as_written: r.place_as_written, name_as_written: r.name_as_written },
      food_entity_id: r.food_entity_id,
      field: r.field,
      variant: r.variant,
      value: r.field === "price" ? Number(String(r.value).split("-")[0]) : r.value,
      value_max: r.field === "price" && String(r.value).includes("-") ? Number(String(r.value).split("-")[1]) : null,
      display_line: this.renderLine(r),
      change: r.change,
      published_value: r.published_value,
      provenance: { source_type: "USER_CONTRIBUTION", source_platform: r.source_platform.toUpperCase(), media_type: r.media_type, assertion: r.assertion_kind, captured_at: r.captured_at },
      confidence: r.confidence,
      own_contribution: r.own_contribution,
    }));
  }

  _log(msg, meta) {
    this.logger?.info?.("CONTRIBUTION", msg, meta);
  }

  _warn(msg, err) {
    this.logger?.warn?.("CONTRIBUTION", msg, { error: String(err?.message ?? err).slice(0, 200) });
  }
}
