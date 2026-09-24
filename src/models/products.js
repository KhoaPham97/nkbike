const mongoose = require("mongoose");

const variantSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },

    price: {
      type: String,
      default: "0",
    },

    qty: {
      type: Number,
      default: 0,
    },
  },
  { _id: false },
);
const productSchema = mongoose.Schema(
  {
    title: {
      type: String,
    },
    price: {
      type: String,
    },
    rating: {
      type: Number,
    },
    originalPrice: {
      type: String,
    },
    thumbnail: {
      type: String,
    },
    images: {
      type: [String],
    },
    detail: {
      type: String,
    },
    description: {
      type: String,
    },
    qty: {
      type: Number,
      default: 0,
    },
    stock: {
      type: String,
    },
    brand: {
      type: String,
    },
    categoryId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "categories",
    },
    category: {
      type: String,
    },
    variants: {
      type: [variantSchema],
      default: [],
    },
    created_at: {
      type: Date,
      default: Date.now,
    },
    updated_at: {
      type: Date,
      default: Date.now,
    },
    type: {
      type: String,
      enum: ["1", "2", "3"],
      default: "1",
    },
  },
  {
    versionKey: false,
  },
);
// ⭐ THÊM INDEX Ở ĐÂY
productSchema.index({ created_at: -1 });

const Product = mongoose.model("products", productSchema);
module.exports = { productSchema, Product };
