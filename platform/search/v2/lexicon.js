// SEARCH INTELLIGENCE V2 — word classes used to separate WHAT is asked (operation, filler) from WHO / WHAT is
// named (brand tokens of a place, dish words). Pure data; nothing here names a dish or a place.
//
// A word is dropped from name matching when it is a question / filler / kind-of-place word. Accents decide:
// "có" (have) is filler, but "Cô" (Miss) is part of names ("Bún cá Cô Ba"). A filler word typed WITHOUT
// accents that could be such a name word ("co", "chi", "con") is kept as OPTIONAL: it may add to a match,
// it never has to match.

const set = (s) => new Set(s.split(/\s+/).filter(Boolean));

// always filler, whatever the accents (folded forms)
export const FILLER_FOLDED = set(`
  khong ko k hong hem nhe nha nhi oi a ha ah voi va hoac thi ma nua them xem tim kiem giup gium lam on vui long
  biet hoi muon can dang shop bot nao dau tai gan gia bao nhieu tien may gio mo cua dong menu thuc don mon gi
  toi tui minh em anh ban cac nhung duoc roi vay the sao nhe ne luon di ah uh u ngon re nhat hay hon
  day kia ay nay do chua xin vui long cam on thank thanks please
  quan tiem restaurant nha hang cafe coffee bistro kitchen bar pub food eatery the at in of
  xung quanh khu vuc trung tam ngoai ra hien bay gio luc nay hom toi sang trua chieu ai vai mot so loai dia chi khac ten dien thoai sdt
`);

// filler only when typed WITH these accents (the folded twin can be a name word)
export const FILLER_ACCENTED = set(`có còn chị chỗ cho ăn uống ở gì là của nào đâu giá này đó ấy kia nhà hàng quán tiệm món`);

// words whose unaccented form stays OPTIONAL in name matching (could be a name word: Cô, Chi, Con, Chợ …)
export const OPTIONAL_FOLDED = set(`co con chi cho an o la cua nha hang mon hong`);

/** dropped: pure filler; optional: may be a name word; required: a name word. */
export function wordClass(token) {
  if (FILLER_ACCENTED.has(token.lower)) return "dropped";
  if (!token.accented && OPTIONAL_FOLDED.has(token.folded)) return "optional";
  if (!FILLER_FOLDED.has(token.folded)) return "required";
  // typed without accents: filler. Typed with accents: filler only in its own spelling ("đâu"), else a name
  // word that happens to fold like one ("Nhật" is not "nhất")
  return !token.accented || ACCENTED_FILLER_OK.has(token.lower) ? "dropped" : "required";
}

// accented spellings of FILLER_FOLDED words that are still filler ("không", "đâu", "giờ" …)
const ACCENTED_FILLER_OK = set(`
  không hông nhé nhá nhỉ ơi à hả với và hoặc thì mà nữa thêm tìm kiếm giúp giùm làm ơn vui lòng biết hỏi muốn cần
  đang nào đâu tại gần giá bao nhiêu tiền mấy giờ mở cửa đóng thực đơn món gì tôi mình em anh bạn các những được rồi
  vậy thế sao nè luôn đi ừ ngon rẻ nhất hay hơn đây kia ấy này đó chưa xin cảm quán tiệm nhà hàng
  xung quanh khu vực trung tâm ngoài hiện bây lúc hôm tối sáng trưa chiều ai vài một số loại bán địa chỉ khác tên điện thoại
`);

// conversational references: "quán đó", "món này", "chỗ kia"
export const REFERENCE_FOLDED = set(`do nay kia ay`);
