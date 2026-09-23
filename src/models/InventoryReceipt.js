const mongoose = require("mongoose");

const inventoryReceiptItemSchema = new mongoose.Schema(
  {
    productId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "products",
      required: true,
    },

    productTitle: {
      type: String,
      default: "",
    },

    variantName: {
      type: String,
      default: "",
    },

    qty: {
      type: Number,
      required: true,
      min: 1,
    },

    unitCost: {
      type: Number,
      default: 0,
      min: 0,
    },

    total: {
      type: Number,
      default: 0,
    },
  },
  {
    _id: false,
  },
);

const inventoryReceiptSchema = new mongoose.Schema(
  {
    code: {
      type: String,
      required: true,
      unique: true,
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
    },

    items: {
      type: [inventoryReceiptItemSchema],
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

    status: {
      type: String,
      enum: ["completed", "cancelled"],
      default: "completed",
    },

    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "users",
      default: null,
    },

    created_at: {
      type: Date,
      default: Date.now,
    },

    updated_at: {
      type: Date,
      default: Date.now,
    },
  },
  {
    versionKey: false,
  },
);

inventoryReceiptSchema.index({
  created_at: -1,
});

const InventoryReceipt =
  mongoose.models.inventory_receipts ||
  mongoose.model("inventory_receipts", inventoryReceiptSchema);

module.exports = InventoryReceipt;
