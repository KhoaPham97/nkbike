const mongoose = require("mongoose");
require("dotenv").config();
require("../src/db/mongoose");

const InventoryBatch = require("../src/models/InventoryBatch");
const { Product } = require("../src/models/products");

// ======================================================
// CONFIG
// ======================================================

// true: chỉ kiểm tra, không ghi database
// false: thực sự cập nhật
const DRY_RUN = false;

const normalize = (value) =>
  String(value || "")
    .trim()
    .toLowerCase();

const getVariantName = (variant) =>
  String(
    variant?.name ||
      variant?.variantName ||
      variant?.title ||
      variant?.label ||
      variant?.value ||
      "",
  ).trim();

const getVariantCode = (variant) => String(variant?.variantCode || "").trim();

// ======================================================
// FIND MATCHING VARIANT
// ======================================================

function findMatchingVariant(product, batch) {
  const variants = Array.isArray(product?.variants) ? product.variants : [];

  if (!variants.length) return null;

  const batchName = normalize(batch.variantName);

  // Ưu tiên đối chiếu chính xác theo tên variant
  if (batchName) {
    const matched = variants.filter(
      (variant) =>
        normalize(getVariantName(variant)) === batchName &&
        getVariantCode(variant),
    );

    // Chỉ cập nhật nếu tìm được duy nhất một kết quả
    if (matched.length === 1) return matched[0];

    if (matched.length > 1) return null;
  }

  // Nếu sản phẩm chỉ có một variant thì có thể xác định an toàn
  if (variants.length === 1) {
    return getVariantCode(variants[0]) ? variants[0] : null;
  }

  return null;
}

// ======================================================
// MAIN
// ======================================================

async function syncBatchVariantCode() {
  let scanned = 0;
  let updated = 0;
  let skipped = 0;
  let missingProduct = 0;
  let missingVariant = 0;

  try {
    await mongoose.connection.asPromise();

    console.log("Đã kết nối MongoDB");
    console.log("Chế độ:", DRY_RUN ? "DRY RUN" : "UPDATE");

    // Chỉ lấy các lô chưa có variantCode
    const batches = await InventoryBatch.find({
      $or: [
        { variantCode: "" },
        { variantCode: null },
        { variantCode: { $exists: false } },
      ],
    })
      .select("_id productId variantName variantCode batchCode source")
      .lean();

    console.log("Số lô cần kiểm tra:", batches.length);

    // Cache Product để tránh truy vấn lặp
    const productCache = new Map();

    for (const batch of batches) {
      scanned++;

      const productId = String(batch.productId || "");

      if (!productId) {
        missingProduct++;
        continue;
      }

      let product = productCache.get(productId);

      if (product === undefined) {
        product = await Product.findById(productId).select("variants").lean();

        productCache.set(productId, product || null);
      }

      if (!product) {
        missingProduct++;

        console.log("[KHÔNG TÌM THẤY PRODUCT]", batch.batchCode, productId);

        continue;
      }

      const variant = findMatchingVariant(product, batch);

      if (!variant) {
        missingVariant++;

        console.log(
          "[KHÔNG GHÉP ĐƯỢC VARIANT]",
          batch.batchCode,
          batch.variantName,
        );

        continue;
      }

      const variantCode = getVariantCode(variant);

      if (!variantCode) {
        skipped++;
        continue;
      }

      console.log(
        `[${DRY_RUN ? "KIỂM TRA" : "CẬP NHẬT"}]`,
        batch.batchCode,
        "|",
        batch.variantName,
        "=>",
        variantCode,
      );

      if (!DRY_RUN) {
        const result = await InventoryBatch.updateOne(
          {
            _id: batch._id,
            $or: [
              { variantCode: "" },
              { variantCode: null },
              { variantCode: { $exists: false } },
            ],
          },
          {
            $set: {
              variantCode,
            },
          },
        );

        if (result.modifiedCount > 0) {
          updated++;
        } else {
          skipped++;
        }
      } else {
        updated++;
      }
    }

    console.log("\n========== KẾT QUẢ ==========");
    console.log("Tổng lô đã kiểm tra:", scanned);
    console.log("Số lô có thể cập nhật:", updated);
    console.log("Không tìm thấy Product:", missingProduct);
    console.log("Không ghép được Variant:", missingVariant);
    console.log("Bỏ qua:", skipped);
    console.log("DRY_RUN:", DRY_RUN);
  } catch (error) {
    console.error("LỖI ĐỒNG BỘ:", error);
  } finally {
    await mongoose.disconnect();
    console.log("Đã ngắt kết nối MongoDB");
  }
}

syncBatchVariantCode();
