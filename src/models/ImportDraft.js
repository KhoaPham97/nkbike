const mongoose = require("mongoose");

const importDraftItemSchema = new mongoose.Schema(
  {
    productId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
    },
    productTitle: {
      type: String,
      default: "",
    },
    productCode: {
      type: String,
      default: "",
    },
    thumbnail: {
      type: String,
      default: "",
    },
    variantName: {
      type: String,
      default: "",
    },
    qty: {
      type: Number,
      default: 0,
      min: 0,
    },
    unitCost: {
      type: Number,
      default: 0,
      min: 0,
    },
    total: {
      type: Number,
      default: 0,
      min: 0,
    },
    currentQty: {
      type: Number,
      default: 0,
    },
  },
  { _id: true },
);

const importDraftSchema = new mongoose.Schema(
  {
    code: {
      type: String,
      unique: true,
      index: true,
    },

    status: {
      type: String,
      enum: ["draft", "completed"],
      default: "draft",
      index: true,
    },

    supplier: {
      type: String,
      default: "",
      trim: true,
    },

    note: {
      type: String,
      default: "",
      trim: true,
    },

    items: {
      type: [importDraftItemSchema],
      default: [],
    },

    totalQty: {
      type: Number,
      default: 0,
    },

    totalAmount: {
      type: Number,
      default: 0,
    },

    receiptId: {
      type: mongoose.Schema.Types.ObjectId,
      default: null,
    },

    completedAt: {
      type: Date,
      default: null,
    },

    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      default: null,
    },

    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      default: null,
    },
  },
  {
    timestamps: true,
  },
);

module.exports =
  mongoose.models.ImportDraft ||
  mongoose.model("ImportDraft", importDraftSchema);
