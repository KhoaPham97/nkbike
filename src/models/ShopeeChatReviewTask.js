const mongoose = require("mongoose");

const shopeeChatReviewTaskSchema = new mongoose.Schema({
  shopId: { type: String, required: true, index: true },
  eventKey: { type: String, required: true, unique: true },
  eventType: { type: String, enum: ["new_order", "shipped", "review"], required: true, index: true },
  referenceId: { type: String, required: true },
  buyerName: { type: String, default: "" },
  buyerId: { type: String, default: "" },
  conversationId: { type: String, default: "" },
  messageText: { type: String, required: true },
  status: { type: String, enum: ["pending", "sent", "dismissed"], default: "pending", index: true },
  sentAt: { type: Date, default: null },
  sentBy: { type: mongoose.Schema.Types.ObjectId, default: null },
}, { timestamps: true, collection: "shopee_chat_review_tasks" });

shopeeChatReviewTaskSchema.index({ shopId: 1, status: 1, createdAt: -1 });

module.exports = mongoose.models.ShopeeChatReviewTask ||
  mongoose.model("ShopeeChatReviewTask", shopeeChatReviewTaskSchema);
