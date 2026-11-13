const mongoose = require("mongoose");

// ======================================================
// ORDER ITEM
// ======================================================

const orderItemSchema = new mongoose.Schema(
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

    productCode: {
      type: String,
      default: "",
    },

    // Tên biến thể
    variantName: {
      type: String,
      default: "",
      trim: true,
    },

    // Mã biến thể - dùng làm khóa nhận diện chính
    variantCode: {
      type: String,
      default: "",
      trim: true,
      index: true,
    },

    price: {
      type: Number,
      default: 0,
    },

    unitCost: {
      type: Number,
      default: null,
    },

    qty: {
      type: Number,
      default: 1,
    },

    total: {
      type: Number,
      default: 0,
    },

    thumbnail: {
      type: String,
      default: "",
    },

    // Phân bổ lô FIFO
    batchAllocations: {
      type: [
        {
          batchId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "InventoryBatch",
            required: true,
          },

          batchCode: {
            type: String,
            default: "",
          },

          // Mã biến thể của lô đã phân bổ
          variantCode: {
            type: String,
            default: "",
            trim: true,
          },

          variantName: {
            type: String,
            default: "",
            trim: true,
          },

          qty: {
            type: Number,
            required: true,
            min: 0,
          },

          unitCost: {
            type: Number,
            default: 0,
            min: 0,
          },
        },
      ],
      default: [],
    },
  },
  {
    _id: false,
  },
);

// ======================================================
// ORDER
// ======================================================

const orderSchema = new mongoose.Schema(
  {
    code: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },

    customerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "customers",
      default: null,
    },

    customerName: {
      type: String,
      default: "Khách lẻ",
    },

    customerPhone: {
      type: String,
      default: "",
    },

    customerAddress: {
      type: String,
      default: "",
    },

    items: {
      type: [orderItemSchema],
      default: [],
    },

    subtotal: {
      type: Number,
      default: 0,
    },

    discount: {
      type: Number,
      default: 0,
    },

    shippingFee: {
      type: Number,
      default: 0,
    },

    totalAmount: {
      type: Number,
      default: 0,
    },

    paidAmount: {
      type: Number,
      default: 0,
    },

    debt: {
      type: Number,
      default: 0,
    },

    paymentMethod: {
      type: String,
      enum: ["cash", "transfer", "cod", "debt"],
      default: "cash",
    },

    status: {
      type: String,
      enum: ["pending", "confirmed", "shipping", "completed", "cancelled"],
      default: "pending",
    },

    note: {
      type: String,
      default: "",
    },

    created_at: {
      type: Date,
      default: Date.now,
    },

    updated_at: {
      type: Date,
      default: Date.now,
    },

    // Đơn đã giữ hàng nhưng chưa trừ tồn thực tế.
    stockReserved: {
      type: Boolean,
      default: false,
      index: true,
    },

    stockReservedAt: {
      type: Date,
      default: null,
    },

    stockDeducted: {
      type: Boolean,
      default: false,
    },
  },
  {
    versionKey: false,
  },
);

// ======================================================
// INDEX
// ======================================================

orderSchema.index({
  created_at: -1,
});

orderSchema.index({
  customerId: 1,
  created_at: -1,
});

// Tìm đơn hàng theo mã biến thể
orderSchema.index({
  "items.productId": 1,
  "items.variantCode": 1,
});

const Order = mongoose.models.orders || mongoose.model("orders", orderSchema);

module.exports = Order;
