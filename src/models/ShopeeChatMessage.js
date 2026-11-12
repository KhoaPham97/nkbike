const mongoose = require("mongoose");

const shopeeChatMessageSchema = new mongoose.Schema(
  {
    shopId: { type: String, required: true, index: true },
    conversationId: { type: String, required: true, index: true },
    messageId: { type: String, required: true },
    fromId: { type: String, default: "" },
    toId: { type: String, default: "" },
    senderType: { type: String, enum: ["buyer", "seller", "system"], default: "system" },
    messageType: { type: String, default: "text" },
    text: { type: String, default: "" },
    content: { type: mongoose.Schema.Types.Mixed, default: {} },
    createdAtShopee: { type: Date, default: null },
    rawData: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true, collection: "shopee_chat_messages" },
);

shopeeChatMessageSchema.index({ shopId: 1, conversationId: 1, messageId: 1 }, { unique: true });
shopeeChatMessageSchema.index({ shopId: 1, conversationId: 1, createdAtShopee: 1 });

module.exports =
  mongoose.models.ShopeeChatMessage ||
  mongoose.model("ShopeeChatMessage", shopeeChatMessageSchema);
