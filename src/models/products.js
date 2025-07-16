const mongoose = require("mongoose");

const productSchema = mongoose.Schema(
  {
    name: {
      type: String,
    },
    price: {
      type: String,
    },
    originalPrice: {
      type: String,
    },
    image: {
      type: String,
    },
    detail: {
      type: String,
    },
    categoryId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "categories",
      required: true,
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
