const mongoose = require("mongoose");

// Sử dụng kết nối MongoDB hiện tại
require("../src/db/mongoose");

const { Product } = require("../src/models/products");

async function waitForDatabase() {
  if (mongoose.connection.readyState === 1) return;

  await new Promise((resolve, reject) => {
    mongoose.connection.once("connected", resolve);
    mongoose.connection.once("error", reject);
  });
}

async function run() {
  let updatedProducts = 0;
  let generatedVariantCodes = 0;
  let generatedSkus = 0;
  let skippedVariants = 0;

  try {
    await waitForDatabase();

    console.log("MongoDB connected:", mongoose.connection.name);

    const products = await Product.find({
      variants: { $exists: true, $ne: [] },
    });

    console.log("Tổng sản phẩm:", products.length);

    for (const product of products) {
      let changed = false;

      for (const variant of product.variants) {
        let needsSave = false;

        if (!variant.variantCode || !String(variant.variantCode).trim()) {
          variant.variantCode = null;
          generatedVariantCodes++;
          needsSave = true;
        }

        if (!variant.sku || !String(variant.sku).trim()) {
          variant.sku = null;
          generatedSkus++;
          needsSave = true;
        }

        if (needsSave) {
          changed = true;
        } else {
          skippedVariants++;
        }
      }

      if (changed) {
        // Hook pre-validate tự sinh cả hai mã còn thiếu
        await product.save();
        updatedProducts++;

        console.log(
          "Đã cập nhật:",
          product.title,
          "|",
          product.variants.length,
          "biến thể",
        );
      }
    }

    console.log("\n========== KẾT QUẢ SYNC ==========");
    console.log("Tổng sản phẩm:", products.length);
    console.log("Sản phẩm cập nhật:", updatedProducts);
    console.log("VariantCode đã tạo:", generatedVariantCodes);
    console.log("SKU đã tạo:", generatedSkus);
    console.log("Biến thể đã đủ mã:", skippedVariants);
    console.log("==================================");
  } catch (error) {
    console.error("SYNC ERROR:", error);
    process.exitCode = 1;
  } finally {
    if (mongoose.connection.readyState !== 0) {
      await mongoose.disconnect();
    }
  }
}

run();
