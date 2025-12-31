const mongoose = require("mongoose");

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
      type: String,
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
  }
);

const Product = mongoose.model("products", productSchema);
module.exports = { productSchema, Product };
