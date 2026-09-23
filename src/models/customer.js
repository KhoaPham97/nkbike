const mongoose = require("mongoose");

const customerSchema = new mongoose.Schema(
  {
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
    },

    note: {
      type: String,
      default: "",
    },

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

customerSchema.index({ phone: 1 });
customerSchema.index({ created_at: -1 });

const Customer =
  mongoose.models.customers || mongoose.model("customers", customerSchema);

module.exports = Customer;
