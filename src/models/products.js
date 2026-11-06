const mongoose = require("mongoose");

// =====================================================
// SYSTEM COUNTER
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

    // Mã biến thể nội bộ, dùng để ánh xạ Shopee.
    variantCode: {
      type: String,
      trim: true,
    },

    // SKU riêng, không dùng thay thế variantCode.
    sku: {
      type: String,
      trim: true,
    },

    price: {
      type: String,
      default: "0",
    },

    defaultPrice: {
      type: String,
      default: "0",
    },

    // Giá vốn lưu bằng CNY.
    unitCost: {
      type: Number,
      default: 0,
      min: 0,
    },

    weight: {
      type: Number,
      default: 0,
      min: 0,
    },

    // Tồn kho thực tế.
    qty: {
      type: Number,
      default: 0,
      min: 0,
    },

    // Số lượng đang được giữ cho các đơn hàng.
    reservedQty: {
      type: Number,
      default: 0,
      min: 0,
    },

    thumbnail: {
      type: String,
      default: "",
    },

    image: {
      type: String,
      default: "",
    },

    // Số sản phẩm trong một kiện.
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

const productSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      default: "",
    },

    price: {
      type: String,
      default: "0",
    },

    rating: {
      type: Number,
      default: 5,
    },

    originalPrice: {
      type: String,
      default: "0",
    },

    thumbnail: {
      type: String,
      default: "",
    },

    images: {
      type: [String],
      default: [],
    },

    detail: {
      type: String,
      default: "",
    },

    description: {
      type: String,
      default: "",
    },

    // Tổng tồn kho thực tế của sản phẩm.
    qty: {
      type: Number,
      default: 0,
      min: 0,
    },

    stock: {
      type: String,
      default: "",
    },

    brand: {
      type: String,
      default: "",
    },

    categoryId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "categories",
      default: null,
    },

    category: {
      type: String,
      default: "",
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

    // Tổng số lượng bán thành công.
    // Chỉ tăng khi đơn chuyển COMPLETED.
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
// TỰ ĐỘNG TẠO variantCode
// Chỉ tạo cho biến thể chưa có mã.
// Không tự thay đổi mã đã tồn tại.
// =====================================================

productSchema.pre("validate", async function () {
  if (Array.isArray(this.variants)) {
    for (const variant of this.variants) {
      const variantCode = String(variant.variantCode || "").trim();
      const sku = String(variant.sku || "").trim();

      // Có cả hai mã: giữ nguyên, tuyệt đối không tự đổi
      if (variantCode && sku) {
        continue;
      }

      // Có NK nhưng thiếu SKU: lấy số từ NK
      if (variantCode && !sku) {
        const suffix = variantCode.match(/(\d+)$/)?.[1];

        if (suffix) {
          variant.sku = `SKU-${suffix}`;
        }
        continue;
      }

      // Có SKU nhưng thiếu NK: lấy số từ SKU
      if (!variantCode && sku) {
        const suffix = sku.match(/(\d+)$/)?.[1];

        if (suffix) {
          variant.variantCode = `NK-${suffix}`;
        }
        continue;
      }

      // Cả hai đều chưa có: dùng chung một số thứ tự
      const code = await generateSequenceCode("product_variant_code", "NK");

      const suffix = code.match(/(\d+)$/)?.[1];

      variant.variantCode = code;
      variant.sku = `SKU-${suffix}`;
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

productSchema.index({
  "variants.variantCode": 1,
});

productSchema.index({
  "variants.sku": 1,
});

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
  generateVariantSku,
};
