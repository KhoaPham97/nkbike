require("dotenv").config();

const mongoose = require("mongoose");

const ShopeeSkuMapping = require("../src/models/ShopeeSkuMapping");
const ShopeeOrder = require("../src//models/ShopeeOrder");
const { Product } = require("../src/models/products");

async function migrateShopeeAutoSync() {
  console.log("===== SHOPEE AUTO SYNC MIGRATION =====");

  // 1. Mapping cũ: mặc định không cho phép trừ kho.
  const mappingResult = await ShopeeSkuMapping.updateMany(
    {
      allowStockDeduction: { $exists: false },
    },
    {
      $set: {
        allowStockDeduction: false,
      },
    },
  );

  console.log("SKU mappings:", mappingResult);

  // 2. Đơn cũ: bổ sung trạng thái giữ kho cho từng item.
  const orderResult = await ShopeeOrder.updateMany(
    {
      "items.allowStockDeduction": { $exists: false },
    },
    {
      $set: {
        "items.$[item].allowStockDeduction": false,
        "items.$[item].quantityMultiplier": 1,
        "items.$[item].reservedQty": 0,
      },
    },
    {
      arrayFilters: [
        {
          "item.allowStockDeduction": { $exists: false },
        },
      ],
    },
  );

  console.log("Shopee orders:", orderResult);

  // 3. Product variants: bổ sung reservedQty.
  const productResult = await Product.collection.updateMany(
    {
      "variants.reservedQty": { $exists: false },
    },
    {
      $set: {
        "variants.$[variant].reservedQty": 0,
      },
    },
    {
      arrayFilters: [
        {
          "variant.reservedQty": { $exists: false },
        },
      ],
    },
  );

  console.log(
    `Đã khởi tạo reservedQty cho ${productResult.modifiedCount} sản phẩm`,
  );

  console.log("Products:", productResult);

  console.log("===== MIGRATION COMPLETED =====");
}

async function main() {
  try {
    if (!process.env.MONGODB_URI) {
      throw new Error("Thiếu MONGO_URI trong file .env");
    }

    await mongoose.connect(process.env.MONGODB_URI);

    console.log("MongoDB connected");

    await migrateShopeeAutoSync();

    process.exitCode = 0;
  } catch (error) {
    console.error("Migration failed:", error);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
  }
}

main();
