const mongoose = require("mongoose");

const chatMessageSchema = new mongoose.Schema(
  {
    conversationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ChatConversation",
      required: true,
      index: true,
    },

    senderType: {
      type: String,
      enum: ["customer", "admin"],
      required: true,
    },

    senderId: {
      type: mongoose.Schema.Types.ObjectId,
      default: null,
    },

    message: {
      type: String,
      default: "",
      trim: true,
    },

    images: {
      type: [String],
      default: [],
    },

    product: {
      productId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Product",
        default: null,
      },

      name: {
        type: String,
        default: "",
      },

      code: {
        type: String,
        default: "",
      },

      price: {
        type: Number,
        default: 0,
      },

      image: {
        type: String,
        default: "",
      },
    },

    isRead: {
      type: Boolean,
      default: false,
    },
  },
  {
    timestamps: true,
    collection: "chat_messages",
  },
);

module.exports = mongoose.model("ChatMessage", chatMessageSchema);
