const mongoose = require("mongoose");

const InventoryHistory = require("../models/inventoryHistory");
const { Product } = require("../models/products");

/**
 * =========================================================
 * HELPER
 * =========================================================
 */

const toNumber = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
};

const isValidObjectId = (value) => {
  return mongoose.Types.ObjectId.isValid(value);
};

const getProductCode = (item) => {
  return item?.productCode || item?.code || item?.sku || "";
};

const normalizeVariantCode = (value) => {
  return String(value || "").trim();
};

const normalizeVariantName = (value) => {
  const name = String(value || "").trim();

  if (!name || name === "Mặc định") {
    return "";
  }

  return name;
};

const normalizeText = (value) => {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "");
};

/**
 * Tìm biến thể:
 * - Có variantCode: bắt buộc khớp chính xác bằng mã.
 * - Không có variantCode: chỉ fallback bằng tên nếu tên duy nhất.
 */
const findVariant = (product, variantName = "", variantCode = "") => {
  const variants = Array.isArray(product?.variants) ? product.variants : [];

  const code = normalizeVariantCode(variantCode);
  const name = normalizeVariantName(variantName);

  if (code) {
    return (
      variants.find(
        (variant) => normalizeVariantCode(variant?.variantCode) === code,
      ) || null
    );
  }

  if (!name) return null;

  const matched = variants.filter(
    (variant) => normalizeVariantName(variant?.name) === name,
  );

  if (matched.length === 1) return matched[0];

  if (matched.length > 1) {
    throw new Error(
      `Tên biến thể "${name}" bị trùng. Cần sử dụng variantCode.`,
    );
  }

  return null;
};

/**
 * =========================================================
 * LIST INVENTORY HISTORY
 * =========================================================
 */

const listInventoryHistoryAsync = async (req, res) => {
  try {
    const { page = 1, limit = 20, search = "", type = "all" } = req.query;

    const currentPage = Math.max(Number(page) || 1, 1);
    const currentLimit = Math.min(Math.max(Number(limit) || 20, 1), 100);

    const skip = (currentPage - 1) * currentLimit;
    const filter = {};

    if (type && type !== "all") {
      filter.type = type;
    }

    const keyword = String(search || "").trim();

    if (keyword) {
      const escapedKeyword = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

      const regex = new RegExp(escapedKeyword, "i");

      filter.$or = [
        { productTitle: regex },
        { productCode: regex },
        { referenceCode: regex },
        { variantName: regex },
        { variantCode: regex },
        { batchCode: regex },
        { note: regex },
      ];
    }

    const [histories, total] = await Promise.all([
      InventoryHistory.find(filter)
        .sort({ created_at: -1, _id: -1 })
        .skip(skip)
        .limit(currentLimit)
        .lean(),

      InventoryHistory.countDocuments(filter),
    ]);

    const totalPages = Math.max(Math.ceil(total / currentLimit), 1);

    return res.status(200).json({
      success: true,
      histories,
      total,
      page: currentPage,
      limit: currentLimit,
      totalPages,
      hasMore: currentPage < totalPages,
    });
  } catch (error) {
    console.error("listInventoryHistoryAsync:", error);

    return res.status(500).json({
      success: false,
      message: error?.message || "Không thể lấy lịch sử kho",
    });
  }
};

/**
 * =========================================================
 * REBUILD INVENTORY HISTORY FROM ORDERS
 * =========================================================
 *
 * Body:
 * {
 *   "replace": true,
 *   "orders": [
 *     {
 *       "_id": "...",
 *       "code": "DH...",
 *       "items": [
 *         {
 *           "productId": "...",
 *           "variantName": "...",
 *           "variantCode": "...",
 *           "qty": 2
 *         }
 *       ],
 *       "stockDeducted": true
 *     }
 *   ]
 * }
 *
 * QUY TẮC:
 * - Chỉ tạo lịch sử cho đơn stockDeducted = true.
 * - Không thay đổi Product.qty.
 * - Không thay đổi Order.
 * - Mỗi item tạo một InventoryHistory.
 * - Số lượng xuất kho là số âm.
 * - Lưu variantCode để phục vụ FIFO.
 * =========================================================
 */

const rebuildInventoryHistoryAsync = async (req, res) => {
  const session = await mongoose.startSession();

  try {
    const { orders = [], replace = false } = req.body || {};

    if (!Array.isArray(orders) || orders.length === 0) {
      return res.status(400).json({
        success: false,
        message: "Danh sách orders không hợp lệ",
      });
    }

    for (let i = 0; i < orders.length; i++) {
      const order = orders[i];

      if (!order) {
        throw new Error(`Đơn hàng thứ ${i + 1} không hợp lệ`);
      }

      if (!order._id) {
        throw new Error(`Đơn hàng thứ ${i + 1} thiếu _id`);
      }

      if (!isValidObjectId(order._id)) {
        throw new Error(`Order ID không hợp lệ: ${order._id}`);
      }

      if (!order.code) {
        throw new Error(`Đơn hàng thứ ${i + 1} thiếu code`);
      }

      if (!Array.isArray(order.items)) {
        throw new Error(`Đơn ${order.code} không có items`);
      }
    }

    const result = {
      totalOrders: orders.length,
      processedOrders: 0,
      skippedOrders: 0,
      totalItems: 0,
      createdHistory: 0,
      skippedItems: 0,
      deletedHistory: 0,
    };

    await session.withTransaction(async () => {
      const sortedOrders = [...orders].sort((a, b) => {
        const dateA = new Date(a.created_at || 0).getTime();
        const dateB = new Date(b.created_at || 0).getTime();

        return dateA - dateB;
      });

      /**
       * Xóa lịch sử cũ của những đơn được gửi lên.
       * Chỉ xóa type order, không xóa lịch sử import/export khác.
       */
      if (replace === true) {
        const orderIds = sortedOrders.map((order) => order._id);

        const deleteResult = await InventoryHistory.deleteMany(
          {
            referenceType: "Order",
            referenceId: { $in: orderIds },
            type: "order",
          },
          { session },
        );

        result.deletedHistory = deleteResult.deletedCount || 0;
      }

      const histories = [];

      for (const order of sortedOrders) {
        if (order.stockDeducted !== true) {
          result.skippedOrders++;
          continue;
        }

        if (!Array.isArray(order.items) || order.items.length === 0) {
          result.skippedOrders++;
          continue;
        }

        if (replace !== true) {
          const existed = await InventoryHistory.exists({
            referenceType: "Order",
            referenceId: order._id,
            type: "order",
          }).session(session);

          if (existed) {
            result.skippedOrders++;
            continue;
          }
        }

        for (const item of order.items) {
          result.totalItems++;

          if (!item?.productId || !isValidObjectId(item.productId)) {
            result.skippedItems++;
            continue;
          }

          const qty = toNumber(item.qty);

          if (!Number.isInteger(qty) || qty <= 0) {
            result.skippedItems++;
            continue;
          }

          const variantName = normalizeVariantName(item.variantName);

          const variantCode = normalizeVariantCode(item.variantCode);

          histories.push({
            type: "order",

            referenceType: "Order",
            referenceId: order._id,
            referenceCode: order.code || "",

            productId: item.productId,
            productTitle: item.productTitle || "",
            productCode: getProductCode(item),

            variantName,
            variantCode,

            qty: -Math.abs(qty),

            beforeQty: Number.isFinite(Number(item.beforeQty))
              ? Number(item.beforeQty)
              : 0,

            afterQty: Number.isFinite(Number(item.afterQty))
              ? Number(item.afterQty)
              : 0,

            note: [
              `Xuất kho theo đơn hàng ${order.code || order._id}`,
              variantCode ? `Mã biến thể: ${variantCode}` : "",
            ]
              .filter(Boolean)
              .join(" | "),

            createdBy: req.user?._id || null,

            rollback: false,
            rollback_at: null,
            rollbackBy: null,

            created_at: order.created_at
              ? new Date(order.created_at)
              : new Date(),
          });
        }

        result.processedOrders++;
      }

      if (histories.length > 0) {
        const inserted = await InventoryHistory.insertMany(histories, {
          session,
          ordered: true,
        });

        result.createdHistory = inserted.length;
      }
    });

    return res.status(200).json({
      success: true,
      message: "Tạo lại lịch sử xuất kho thành công",
      totalOrders: result.totalOrders,
      processedOrders: result.processedOrders,
      skippedOrders: result.skippedOrders,
      totalItems: result.totalItems,
      createdHistory: result.createdHistory,
      skippedItems: result.skippedItems,
      deletedHistory: result.deletedHistory,
    });
  } catch (error) {
    console.error("rebuildInventoryHistoryAsync:", error);

    return res.status(400).json({
      success: false,
      message: error?.message || "Không thể tạo lại lịch sử xuất kho",
    });
  } finally {
    await session.endSession();
  }
};

/**
 * =========================================================
 * SYNC INVENTORY HISTORY UNIT COST
 * =========================================================
 *
 * - Chỉ cập nhật unitCost chưa có hoặc bằng 0.
 * - Tìm Product theo productId.
 * - Ưu tiên tìm variant bằng variantCode.
 * - Chỉ fallback variantName nếu tên khớp duy nhất.
 * - Lấy Product.variants[].defaultPrice.
 * - Giữ nguyên đơn vị CNY.
 * - Không thay đổi qty, tồn kho hoặc rollback.
 * =========================================================
 */

const syncInventoryHistoryUnitCosts = async (req, res) => {
  try {
    const histories = await InventoryHistory.find({
      $or: [
        { unitCost: { $exists: false } },
        { unitCost: null },
        { unitCost: 0 },
      ],
    })
      .select(
        "_id productId productTitle variantName variantCode batchId batchCode unitCost note",
      )
      .lean();

    if (!histories.length) {
      return res.status(200).json({
        success: true,
        message: "Không có lịch sử cần đồng bộ giá vốn",
        summary: {
          total: 0,
          updated: 0,
          skipped: 0,
          failed: 0,
        },
        details: [],
      });
    }

    const productIds = [
      ...new Set(
        histories
          .filter((item) => mongoose.Types.ObjectId.isValid(item.productId))
          .map((item) => String(item.productId)),
      ),
    ];

    const products = await Product.find({
      _id: { $in: productIds },
    })
      .select("_id title variants")
      .lean();

    const productMap = new Map(
      products.map((product) => [String(product._id), product]),
    );

    let updated = 0;
    let skipped = 0;
    let failed = 0;

    const details = [];

    for (const history of histories) {
      try {
        const product = productMap.get(String(history.productId));

        if (!product) {
          skipped++;

          details.push({
            id: history._id,
            status: "skipped",
            reason: "Không tìm thấy sản phẩm",
          });

          continue;
        }

        const variantCode = normalizeVariantCode(history.variantCode);

        const variantName = normalizeVariantName(history.variantName);

        let variant;

        try {
          variant = findVariant(product, variantName, variantCode);
        } catch (error) {
          skipped++;

          details.push({
            id: history._id,
            productTitle: product.title,
            variantName,
            variantCode,
            status: "skipped",
            reason: error.message,
          });

          continue;
        }

        if (!variant) {
          skipped++;

          details.push({
            id: history._id,
            productTitle: product.title,
            variantName,
            variantCode,
            status: "skipped",
            reason: variantCode
              ? "Không tìm thấy biến thể theo variantCode"
              : "Không tìm thấy duy nhất một biến thể theo variantName",
          });

          continue;
        }

        const unitCost = Number(variant.defaultPrice);

        if (!Number.isFinite(unitCost) || unitCost <= 0) {
          skipped++;

          details.push({
            id: history._id,
            productTitle: product.title,
            variantName: variant.name || variantName,
            variantCode: variant.variantCode || variantCode,
            status: "skipped",
            reason: "Biến thể chưa có defaultPrice hợp lệ",
          });

          continue;
        }

        const updateResult = await InventoryHistory.updateOne(
          {
            _id: history._id,
            $or: [
              { unitCost: { $exists: false } },
              { unitCost: null },
              { unitCost: 0 },
            ],
          },
          {
            $set: {
              unitCost,
              variantCode:
                variantCode || normalizeVariantCode(variant.variantCode),
              variantName: variantName || normalizeVariantName(variant.name),
            },
            $push: {
              note: {
                $each: [],
              },
            },
          },
        );

        /**
         * Ghi chú đồng bộ giá vốn.
         * Dùng update riêng để không ghi đè nội dung note cũ.
         */
        if (updateResult.modifiedCount > 0) {
          await InventoryHistory.updateOne(
            { _id: history._id },
            {
              $set: {
                note: [
                  history.note,
                  "Đồng bộ giá vốn từ Product.variants.defaultPrice",
                ]
                  .filter(Boolean)
                  .join(" | "),
              },
            },
          );

          updated++;

          details.push({
            id: history._id,
            productTitle: product.title,
            variantName: variant.name || variantName,
            variantCode: variant.variantCode || variantCode,
            batchCode: history.batchCode,
            unitCost,
            currency: "CNY",
            status: "updated",
          });
        } else {
          skipped++;

          details.push({
            id: history._id,
            status: "skipped",
            reason: "Bản ghi đã được cập nhật hoặc không còn đủ điều kiện",
          });
        }
      } catch (error) {
        failed++;

        details.push({
          id: history._id,
          status: "failed",
          reason: error.message,
        });
      }
    }

    return res.status(200).json({
      success: true,
      message: "Đồng bộ giá vốn lịch sử kho hoàn tất",
      summary: {
        total: histories.length,
        updated,
        skipped,
        failed,
      },
      details,
    });
  } catch (error) {
    console.error("syncInventoryHistoryUnitCosts:", error);

    return res.status(500).json({
      success: false,
      message: "Lỗi đồng bộ giá vốn lịch sử kho",
      error: error.message,
    });
  }
};

/**
 * =========================================================
 * EXPORT
 * =========================================================
 */

module.exports = {
  listInventoryHistoryAsync,
  rebuildInventoryHistoryAsync,
  syncInventoryHistoryUnitCosts,
};
