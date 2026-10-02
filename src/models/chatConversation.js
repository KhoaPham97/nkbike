const mongoose = require("mongoose");

const chatConversationSchema = new mongoose.Schema(
  {
    customerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Customer",
      required: true,
      index: true,
    },

    status: {
      type: String,
      enum: ["open", "closed"],
      default: "open",
      index: true,
    },

    lastMessage: {
      type: String,
      default: "",
    },

    lastMessageAt: {
      type: Date,
      default: Date.now,
      index: true,
    },

    unreadCustomer: {
      type: Number,
      default: 0,
      min: 0,
    },

    unreadAdmin: {
      type: Number,
      default: 0,
      min: 0,
    },

    productContext: {
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
  },
  {
    timestamps: true,
    collection: "chat_conversations",
  },
);

module.exports = mongoose.model("ChatConversation", chatConversationSchema);
