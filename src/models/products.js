const mongoose = require("mongoose");

// =====================================================
// COUNTER: TẠO MÃ BIẾN THỂ TUẦN TỰ, KHÔNG TRÙNG
// =====================================================

const counterSchema = new mongoose.Schema(
  {
    _id: String,
    seq: {
      type: Number,
      default: 10000,
    },
  },
  {
    versionKey: false,
    collection: "system_counters",
  },
);

const SystemCounter =
  mongoose.models.SystemCounter ||
  mongoose.model("SystemCounter", counterSchema);

// Tạo mã tuần tự riêng cho từng loại
async function generateSequenceCode(counterName, prefix) {
  const counter = await SystemCounter.findOneAndUpdate(
    { _id: counterName },
    { $inc: { seq: 1 } },
    {
      new: true,
      upsert: true,
      setDefaultsOnInsert: true,
    },
  );

  return `${prefix}-${counter.seq}`;
}

async function generateVariantCode() {
  return generateSequenceCode("product_variant_code", "NK");
}

async function generateVariantSku() {
  return generateSequenceCode("product_variant_sku", "SKU");
}
async function generateVariantCode() {
  const counter = await SystemCounter.findOneAndUpdate(
    { _id: "product_variant_code" },
    {
      $inc: { seq: 1 },
    },
    {
      new: true,
      upsert: true,
      setDefaultsOnInsert: true,
    },
  );

  return `NK-${counter.seq}`;
}

// =====================================================
// VARIANT SCHEMA
// =====================================================

const variantSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },

    // Mã biến thể dùng để ánh xạ Shopee
    variantCode: {
      type: String,
      trim: true,
      index: true,
    },

    price: {
      type: String,
      default: "0",
    },

    defaultPrice: {
      type: String,
      default: "0",
    },

    unitCost: {
      type: Number,
      default: 0,
      min: 0,
    },

    weight: {
      type: Number,
      default: 0,
    },

    qty: {
      type: Number,
      default: 0,
    },

    // Giữ nguyên mã cũ
    variantCode: {
      type: String,
      trim: true,
      index: true,
    },

    sku: {
      type: String,
      trim: true,
      index: true,
    },

    thumbnail: String,
    image: String,

    packageQuantity: {
      type: Number,
      default: 1,
      min: 1,
    },
  },
  { _id: false },
);

// =====================================================
// PRODUCT SCHEMA
// =====================================================

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

    soldQty: {
      type: Number,
      default: 0,
      min: 0,
    },

    isVisible: {
      type: Boolean,
      default: true,
    },

    compatibleVehicles: {
      type: [String],
      default: [],
    },
  },
  {
    versionKey: false,
  },
);

// =====================================================
// TỰ ĐỘNG TẠO variantCode KHI LƯU PRODUCT
// Chỉ tạo cho biến thể chưa có mã
// =====================================================

productSchema.pre("validate", async function () {
  if (!Array.isArray(this.variants)) return;

  for (const variant of this.variants) {
    // Tự sinh mã biến thể
    if (!variant.variantCode || !variant.variantCode.trim()) {
      variant.variantCode = await generateVariantCode();
    }

    // Tự sinh SKU
    if (!variant.sku || !variant.sku.trim()) {
      variant.sku = await generateVariantSku();
    }
  }

  this.updated_at = new Date();
});

// =====================================================
// INDEX
// =====================================================

productSchema.index({ created_at: -1 });
productSchema.index({ compatibleVehicles: 1 });
productSchema.index({ type: 1, compatibleVehicles: 1 });

// =====================================================
// MODEL
// =====================================================

const Product =
  mongoose.models.products || mongoose.model("products", productSchema);

module.exports = {
  productSchema,
  variantSchema,
  Product,
  generateVariantCode,
};
