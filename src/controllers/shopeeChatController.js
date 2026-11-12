const ShopeeChatConversation = require("../models/ShopeeChatConversation");
const ShopeeChatMessage = require("../models/ShopeeChatMessage");
const {
  getShopeeChatConversations,
  getShopeeChatMessages,
  sendShopeeChatMessage,
  readShopeeChatConversation,
} = require("../services/shopeeService");

const text = (value) => String(value ?? "").trim();
// Shopee có thể trả timestamp dạng giây, milliseconds hoặc chuỗi ngày ISO.
 // Luôn kiểm tra Date#getTime() vì Number.isFinite() chưa loại được
 // timestamp quá lớn khiến new Date(...) vẫn tạo ra Invalid Date.
const dateFromSeconds = (value) => {
  if (value === null || value === undefined || value === "") return null;

  let date;
  const raw = String(value).trim();
  const numeric = Number(raw);

  if (raw !== "" && Number.isFinite(numeric)) {
    let milliseconds = numeric;

    if (Math.abs(numeric) >= 1e17) {
      milliseconds = numeric / 1e6; // nanoseconds -> milliseconds
    } else if (Math.abs(numeric) >= 1e14) {
      milliseconds = numeric / 1e3; // microseconds -> milliseconds
    } else if (Math.abs(numeric) < 1e11) {
      milliseconds = numeric * 1000; // seconds -> milliseconds
    }

    date = new Date(milliseconds);
  } else {
    date = new Date(raw);
  }

  return Number.isFinite(date.getTime()) ? date : null;
};
const getMessageText = (message = {}) => {
  const content = message.content || {};
  return text(content.text || content.custom_preview_text?.text || message.text || message.preview_text);
};
const getBuyer = (conversation = {}) => ({
  buyerId: text(conversation.to_id || conversation.user_id || conversation.buyer_id),
  buyerName: text(conversation.to_name || conversation.username || conversation.buyer_name || "Khách Shopee"),
  buyerAvatar: text(conversation.to_avatar || conversation.avatar || conversation.profile_picture || ""),
});
const errorMessage = (error) => {
  const data = error?.response?.data || error?.responseData || {};
  const raw = text(data.message || data.msg || error?.message);
  if (/permission|forbidden|not authorized|access denied|no permission/i.test(raw)) {
    return "Shopee chưa cấp quyền Chat API cho ứng dụng. Hãy yêu cầu mở quyền Chat API trong Shopee Open Platform.";
  }
  return raw || "Không thể xử lý Shopee Chat.";
};
const sendError = (res, error, status = 400) =>
  res.status(status).json({ success: false, message: errorMessage(error), code: error?.shopeeError || error?.code || null });

exports.getConversations = async (req, res) => {
  try {
    const shopId = text(req.query.shopId);
    if (!shopId) return res.status(400).json({ success: false, message: "Vui lòng chọn gian hàng Shopee." });
    const type = req.query.type === "unread" ? "unread" : "all";
    const result = await getShopeeChatConversations(shopId, {
      direction: "latest",
      type,
      pageSize: Math.min(Number(req.query.pageSize) || 40, 100),
      nextTimestampNano: req.query.nextTimestampNano,
    });
    const conversations = Array.isArray(result.conversations) ? result.conversations : [];
    const normalized = [];
    for (const item of conversations) {
      const conversationId = text(item.conversation_id || item.conversationId);
      if (!conversationId) continue;
      const buyer = getBuyer(item);
      // Shopee v2 trả phần nội dung cuối và metadata người gửi ở các field riêng.
      // latest_message_content chỉ chứa nội dung (ví dụ { text }), không có from_id.
      const latestContent = item.latest_message_content || item.last_message?.content || item.lastMessage?.content || {};
      const last = {
        ...latestContent,
        message_id: item.latest_message_id || item.last_message?.message_id || "",
        message_type: item.latest_message_type || item.last_message?.message_type || "text",
        from_id: item.latest_message_from_id ?? item.last_message?.from_id ?? "",
        content: latestContent,
      };
      const timestamp = item.last_message_timestamp || item.last_message_time || item.last_message?.created_timestamp || item.lastMessageTime;
      const lastSenderId = text(item.latest_message_from_id ?? last.from_id ?? last.fromId ?? last.sender_id);
      // Trong conversation list, to_id là buyer user_id; latest_message_from_id là user_id người gửi.
      const lastMessageFromBuyer = Boolean(lastSenderId && buyer.buyerId && lastSenderId === buyer.buyerId);
      const update = {
        shopId,
        conversationId,
        ...buyer,
        lastMessage: last,
        lastMessageAt: dateFromSeconds(timestamp) || new Date(),
        unreadCount: Number(item.unread_count ?? item.unreadCount ?? 0),
        lastMessageFromBuyer,
        pinned: Boolean(item.pinned || item.is_pinned),
        rawData: item,
        syncedAt: new Date(),
      };
      await ShopeeChatConversation.findOneAndUpdate(
        { shopId, conversationId },
        { $set: update },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      );
      normalized.push({ ...update, preview: getMessageText({ ...last, content: last.content || last }), conversationId });
    }
    const pageResult = result.page_result || {};
    return res.json({
      success: true,
      conversations: normalized,
      total: normalized.length,
      more: Boolean(pageResult.more),
      nextCursor: pageResult.next_cursor?.next_message_time_nano || pageResult.next_cursor || null,
      nextConversationId: pageResult.next_cursor?.conversation_id || null,
      syncedAt: new Date(),
    });
  } catch (error) {
    console.error("[Shopee Chat] getConversations:", error?.response?.data || error);
    // Giữ danh sách đã đồng bộ trước đó nếu Shopee tạm trả về 404.
    if (Number(error?.response?.status || error?.status) === 404) {
      try {
        const shopId = text(req.query.shopId);
        const cached = await ShopeeChatConversation.find({ shopId })
          .sort({ lastMessageFromBuyer: -1, unreadCount: -1, lastMessageAt: -1 })
          .limit(Math.min(Number(req.query.pageSize) || 40, 100))
          .lean();
        if (cached.length) {
          return res.json({
            success: true,
            conversations: cached.map((item) => ({
              ...item,
              preview: getMessageText({ ...(item.lastMessage || {}), content: item.lastMessage?.content || item.lastMessage || {} }),
              cached: true,
            })),
            total: cached.length,
            cached: true,
            warning: "Shopee đang trả về 404; đang hiển thị hội thoại đã lưu gần nhất.",
          });
        }
      } catch (cacheError) {
        console.error("[Shopee Chat] cache fallback:", cacheError);
      }
    }
    return sendError(res, error, Number(error?.response?.status || error?.status) || 400);
  }
};

exports.getMessages = async (req, res) => {
  try {
    const shopId = text(req.query.shopId);
    const conversationId = text(req.params.conversationId);
    if (!shopId || !conversationId) return res.status(400).json({ success: false, message: "Thiếu shopId hoặc conversationId." });
    const result = await getShopeeChatMessages(shopId, {
      conversationId,
      offset: req.query.offset || "0",
      pageSize: Math.min(Number(req.query.pageSize) || 50, 100),
    });
    const messages = Array.isArray(result.messages) ? result.messages : [];
    for (const item of messages) {
      const messageId = text(item.message_id || item.messageId || item.id);
      if (!messageId) continue;
      const fromId = text(item.from_id || item.fromId);
      const content = item.content || {};
      const message = {
        shopId,
        conversationId,
        messageId,
        fromId,
        toId: text(item.to_id || item.toId),
        senderType: text(item.from_shop_id) === shopId ? "seller" : (fromId ? "buyer" : "system"),
        messageType: text(item.message_type || item.type || "text"),
        text: getMessageText(item),
        content,
        createdAtShopee: dateFromSeconds(item.created_timestamp || item.created_at),
        rawData: item,
      };
      await ShopeeChatMessage.findOneAndUpdate(
        { shopId, conversationId, messageId },
        { $set: message },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      );
    }
    const saved = await ShopeeChatMessage.find({ shopId, conversationId })
      .sort({ createdAtShopee: 1, createdAt: 1 })
      .limit(300)
      .lean();
    return res.json({
      success: true,
      messages: saved,
      nextOffset: result.page_result?.next_offset || "",
      pageSize: result.page_result?.page_size || messages.length,
    });
  } catch (error) {
    console.error("[Shopee Chat] getMessages:", error?.response?.data || error);
    return sendError(res, error);
  }
};

exports.sendMessage = async (req, res) => {
  try {
    const shopId = text(req.body.shopId);
    const conversationId = text(req.params.conversationId);
    const toId = text(req.body.toId);
    const messageText = text(req.body.text);
    if (!shopId || !conversationId || !toId || !messageText) {
      return res.status(400).json({ success: false, message: "Thiếu shopId, người nhận hoặc nội dung tin nhắn." });
    }
    const result = await sendShopeeChatMessage(shopId, { toId, text: messageText });
    const messageId = text(result.message_id || result.messageId);
    const saved = {
      shopId,
      conversationId,
      messageId: messageId || `local-${Date.now()}`,
      fromId: "",
      toId,
      senderType: "seller",
      messageType: "text",
      text: messageText,
      content: result.content || { text: messageText },
      createdAtShopee: dateFromSeconds(result.created_timestamp) || new Date(),
      rawData: result,
    };
    await ShopeeChatMessage.findOneAndUpdate(
      { shopId, conversationId, messageId: saved.messageId },
      { $set: saved },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    await ShopeeChatConversation.findOneAndUpdate(
      { shopId, conversationId },
      { $set: { lastMessage: saved.content, lastMessageAt: saved.createdAtShopee, syncedAt: new Date() } },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    return res.json({ success: true, message: saved });
  } catch (error) {
    console.error("[Shopee Chat] sendMessage:", error?.response?.data || error);
    return sendError(res, error);
  }
};

exports.markRead = async (req, res) => {
  try {
    const shopId = text(req.body.shopId || req.query.shopId);
    const conversationId = text(req.params.conversationId);
    const lastReadMessageId = text(req.body.lastReadMessageId);
    if (!shopId || !conversationId || !lastReadMessageId) {
      return res.status(400).json({ success: false, message: "Thiếu thông tin đánh dấu đã đọc." });
    }
    const result = await readShopeeChatConversation(shopId, { conversationId, lastReadMessageId });
    await ShopeeChatConversation.updateOne({ shopId, conversationId }, { $set: { unreadCount: 0 } });
    return res.json({ success: true, data: result });
  } catch (error) {
    console.error("[Shopee Chat] markRead:", error?.response?.data || error);
    return sendError(res, error);
  }
};
