const mongoose = require("mongoose");
require("dotenv").config();
require("../src/db/mongoose");

const Order = require("../src/models/orders");
const { Product } = require("../src/models/products");

// ======================================================
// CONFIG
// ======================================================

const DRY_RUN = false; // true = chỉ kiểm tra, không ghi database

const normalize = (value) =>
  String(value || "")
    .trim()
    .toLowerCase();

const toNumber = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

// ======================================================
// FIND VARIANT
// ======================================================

function findProductVariant(product, orderItem) {
  const variants = Array.isArray(product?.variants) ? product.variants : [];

  if (!variants.length) return null;

  const variantCode = normalize(orderItem.variantCode);
  const variantName = normalize(orderItem.variantName);

  // Ưu tiên tìm bằng variantCode
  if (variantCode) {
    const matchedByCode = variants.find(
      (variant) =>
        normalize(variant.variantCode || variant.code || variant.sku) ===
        variantCode,
    );

    if (matchedByCode) return matchedByCode;
  }

  // Nếu không tìm thấy code thì tìm bằng tên
  if (variantName) {
    const matchedByName = variants.find(
      (variant) =>
        normalize(
          variant.name || variant.title || variant.label || variant.value,
        ) === variantName,
    );

    if (matchedByName) return matchedByName;
  }

  return null;
}

// ======================================================
// MAIN
// ======================================================

async function syncOrderUnitCost() {
  let scannedOrders = 0;
  let updatedOrders = 0;
  let updatedItems = 0;
  let notFoundProducts = 0;
  let notFoundVariants = 0;
  let missingUnitCost = 0;

  try {
    await mongoose.connection.asPromise();

    console.log("Đã kết nối MongoDB");

    const orders = await Order.find({}).select("_id code items").lean();

    console.log("Tổng đơn hàng:", orders.length);

    for (const order of orders) {
      scannedOrders++;

      let orderChanged = false;

      const items = Array.isArray(order.items) ? order.items : [];

      for (let index = 0; index < items.length; index++) {
        const item = items[index];

        if (!item.productId) {
          notFoundProducts++;
          continue;
        }

        const product = await Product.findById(item.productId)
          .select("variants")
          .lean();

        if (!product) {
          notFoundProducts++;
          console.log(
            `[Không tìm thấy Product] Đơn ${order.code}, item ${index + 1}`,
          );
          continue;
        }

        const variant = findProductVariant(product, item);

        if (!variant) {
          notFoundVariants++;
          console.log(`[Không tìm thấy Variant] Đơn ${order.code}`, {
            productId: String(item.productId),
            variantCode: item.variantCode,
            variantName: item.variantName,
          });
          continue;
        }

        const unitCost = toNumber(variant.unitCost);

        if (unitCost === null) {
          missingUnitCost++;
          console.log(
            `[Variant chưa có unitCost] Đơn ${order.code}`,
            item.variantName,
          );
          continue;
        }

        // Cập nhật unitCost trong order item
        items[index].unitCost = unitCost;

        // Xóa trường defaultPrice cũ nếu còn tồn tại
        delete items[index].defaultPrice;

        updatedItems++;
        orderChanged = true;

        console.log(
          `[OK] ${order.code} | ${item.variantName} | unitCost: ${unitCost}`,
        );
      }

      if (orderChanged) {
        if (!DRY_RUN) {
          await Order.updateOne(
            { _id: order._id },
            {
              $set: {
                items: items.map((item) => {
                  const updatedItem = { ...item };
                  delete updatedItem.defaultPrice;
                  return updatedItem;
                }),
              },
            },
          );
        }

        updatedOrders++;
      }
    }

    console.log("\n========== KẾT QUẢ ==========");
    console.log("Đơn hàng đã quét:", scannedOrders);
    console.log("Đơn hàng có thay đổi:", updatedOrders);
    console.log("Sản phẩm đã cập nhật:", updatedItems);
    console.log("Không tìm thấy Product:", notFoundProducts);
    console.log("Không tìm thấy Variant:", notFoundVariants);
    console.log("Variant chưa có unitCost:", missingUnitCost);
    console.log("Chế độ:", DRY_RUN ? "DRY RUN" : "ĐÃ GHI DATABASE");
  } catch (error) {
    console.error("Lỗi migration:", error);
  } finally {
    await mongoose.disconnect();
    console.log("Đã ngắt kết nối MongoDB");
  }
}

syncOrderUnitCost();
