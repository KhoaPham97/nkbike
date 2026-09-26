const mongoose = require("mongoose");

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

    variantName: {
      type: String,
      default: "",
    },

    price: {
      type: Number,
      default: 0,
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
  },
  {
    _id: false,
  },
);

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
    stockDeducted: {
      type: Boolean,
      default: false,
    },
  },
  {
    versionKey: false,
  },
);

orderSchema.index({
  created_at: -1,
});

orderSchema.index({
  customerId: 1,
  created_at: -1,
});

const Order = mongoose.models.orders || mongoose.model("orders", orderSchema);

module.exports = Order;
