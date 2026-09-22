import { findMatchingRestaurants, formatRestaurantList } from "./foodRecommender.js";
import { polishFoodReply } from "./llm.js";

const GREETING_REPLY = "Dạ em chào anh/chị, em là Mary — hỗ trợ ẩm thực & thông tin quán ăn qua Zalo. Anh/chị cần tìm quán gì hay khu vực nào ạ?";
const DOMAIN_REPLY = "Dạ về thông tin khóa học/ngành học, anh/chị vui lòng để lại số điện thoại, bên em sẽ có nhân viên tư vấn liên hệ lại sớm nhất ạ.";
const FALLBACK_REPLY = "Dạ em chưa rõ ý anh/chị lắm, anh/chị có thể nói rõ hơn giúp em (ví dụ: tên món, khu vực) để em hỗ trợ tốt hơn nha.";

export async function buildReply(intent, userText) {
  switch (intent) {
    case "support_food_recommendation": {
      const matches = findMatchingRestaurants(userText);
      const polished = await polishFoodReply(userText, matches);
      return polished || formatRestaurantList(matches);
    }
    case "domain_open_status":
      return DOMAIN_REPLY;
    case "greeting":
      return GREETING_REPLY;
    default:
      return FALLBACK_REPLY;
  }
}
