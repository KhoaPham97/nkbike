const mongoose = require("mongoose");

const shopeeChatConversationSchema = new mongoose.Schema(
  {
    shopId: { type: String, required: true, index: true },
    conversationId: { type: String, required: true },
    buyerId: { type: String, default: "" },
    buyerName: { type: String, default: "" },
    buyerAvatar: { type: String, default: "" },
    lastMessage: { type: mongoose.Schema.Types.Mixed, default: {} },
    lastMessageAt: { type: Date, default: Date.now, index: true },
    unreadCount: { type: Number, default: 0 },
    lastMessageFromBuyer: { type: Boolean, default: false, index: true },
    pinned: { type: Boolean, default: false },
    rawData: { type: mongoose.Schema.Types.Mixed, default: {} },
    syncedAt: { type: Date, default: Date.now },
  },
  { timestamps: true, collection: "shopee_chat_conversations" },
);

shopeeChatConversationSchema.index({ shopId: 1, conversationId: 1 }, { unique: true });
shopeeChatConversationSchema.index({ shopId: 1, lastMessageAt: -1 });

module.exports =
  mongoose.models.ShopeeChatConversation ||
  mongoose.model("ShopeeChatConversation", shopeeChatConversationSchema);
