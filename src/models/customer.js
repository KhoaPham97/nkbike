const mongoose = require("mongoose");

const customerSchema = new mongoose.Schema(
  {
    // =========================
    // THÔNG TIN KHÁCH HÀNG
    // =========================
    name: {
      type: String,
      required: true,
      trim: true,
    },

    phone: {
      type: String,
      default: "",
      trim: true,
    },

    address: {
      type: String,
      default: "",
      trim: true,
    },

    email: {
      type: String,
      default: "",
      trim: true,
      lowercase: true,
    },

    // =========================
    // TÀI KHOẢN ĐĂNG NHẬP
    // =========================
    username: {
      type: String,
      // required: true,
      unique: true,
      trim: true,
      lowercase: true,
    },

    password: {
      type: String,
      required: true,
      select: false,
    },

    // pending  = chờ admin duyệt
    // active   = được phép đăng nhập
    // blocked  = bị khóa
    status: {
      type: String,
      enum: ["pending", "active", "blocked"],
      default: "pending",
      index: true,
    },

    // =========================
    // THỐNG KÊ
    // =========================
    totalOrders: {
      type: Number,
      default: 0,
    },

    totalSpent: {
      type: Number,
      default: 0,
    },

    debt: {
      type: Number,
      default: 0,
    },

    // =========================
    // KHÁC
    // =========================
    note: {
      type: String,
      default: "",
    },

    lastLoginAt: {
      type: Date,
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

// =========================
// INDEX
// =========================

customerSchema.index({ phone: 1 });
customerSchema.index({ email: 1 });
customerSchema.index({ username: 1 });
customerSchema.index({ status: 1 });
customerSchema.index({ created_at: -1 });

// =========================
// MODEL
// =========================

const Customer =
  mongoose.models.customers || mongoose.model("customers", customerSchema);

module.exports = Customer;
