const mongoose = require("mongoose");

const InventoryHistory = require("../models/inventoryHistory");

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

const normalizeVariantName = (value) => {
  const name = String(value || "").trim();

  if (!name || name === "Mặc định") {
    return "";
  }

  return name;
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

    const currentLimit = Math.min(Number(limit) || 20, 100);

    const skip = (currentPage - 1) * currentLimit;

    const filter = {};

    // =====================================================
    // TYPE
    // =====================================================

    if (type && type !== "all") {
      filter.type = type;
    }

    // =====================================================
    // SEARCH
    // =====================================================

    const keyword = String(search || "").trim();

    if (keyword) {
      filter.$or = [
        {
          productTitle: {
            $regex: keyword,
            $options: "i",
          },
        },
        {
          productCode: {
            $regex: keyword,
            $options: "i",
          },
        },
        {
          referenceCode: {
            $regex: keyword,
            $options: "i",
          },
        },
        {
          variantName: {
            $regex: keyword,
            $options: "i",
          },
        },
        {
          note: {
            $regex: keyword,
            $options: "i",
          },
        },
      ];
    }

    // =====================================================
    // QUERY
    // =====================================================

    const [histories, total] = await Promise.all([
      InventoryHistory.find(filter)
        .sort({
          created_at: -1,
        })
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
 *
 * {
 *   "replace": true,
 *   "orders": [
 *      {
 *        "_id": "...",
 *        "code": "DH...",
 *        "items": [...]
 *        "stockDeducted": true
 *      }
 *   ]
 * }
 *
 * =========================================================
 *
 * QUY TẮC:
 *
 * - stockDeducted = true
 *      => tạo history
 *
 * - stockDeducted = false
 *      => bỏ qua
 *
 * - Không thay đổi Product.qty
 *
 * - Không thay đổi Order
 *
 * - Mỗi item = 1 InventoryHistory
 *
 * - qty xuất kho = số âm
 *
 * =========================================================
 */

const rebuildInventoryHistoryAsync = async (req, res) => {
  const session = await mongoose.startSession();

  try {
    const { orders = [], replace = false } = req.body || {};

    // =====================================================
    // VALIDATE ORDERS
    // =====================================================

    if (!Array.isArray(orders) || orders.length === 0) {
      return res.status(400).json({
        success: false,
        message: "Danh sách orders không hợp lệ",
      });
    }

    // =====================================================
    // VALIDATE ORDER
    // =====================================================

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
        throw new Error(`Đơn hàng ${i + 1} thiếu code`);
      }

      if (!Array.isArray(order.items)) {
        throw new Error(`Đơn ${order.code} không có items`);
      }
    }

    let result = {
      totalOrders: orders.length,

      processedOrders: 0,

      skippedOrders: 0,

      totalItems: 0,

      createdHistory: 0,

      skippedItems: 0,

      deletedHistory: 0,
    };

    // =====================================================
    // TRANSACTION
    // =====================================================

    await session.withTransaction(async () => {
      // ===================================================
      // SORT ORDER
      // ===================================================
      //
      // Đơn cũ xử lý trước.
      //
      const sortedOrders = [...orders].sort((a, b) => {
        const dateA = new Date(a.created_at || 0).getTime();

        const dateB = new Date(b.created_at || 0).getTime();

        return dateA - dateB;
      });

      // ===================================================
      // REPLACE OLD HISTORY
      // ===================================================

      if (replace === true) {
        const orderIds = sortedOrders.map((order) => order._id);

        const deleteResult = await InventoryHistory.deleteMany(
          {
            referenceType: "Order",

            referenceId: {
              $in: orderIds,
            },

            type: "order",
          },
          {
            session,
          },
        );

        result.deletedHistory = deleteResult.deletedCount || 0;
      }

      // ===================================================
      // PREPARE HISTORY
      // ===================================================

      const histories = [];

      // ===================================================
      // PROCESS ORDERS
      // ===================================================

      for (const order of sortedOrders) {
        // =================================================
        // CHƯA TRỪ KHO
        // =================================================

        if (order.stockDeducted !== true) {
          result.skippedOrders++;

          continue;
        }

        // =================================================
        // KHÔNG CÓ ITEMS
        // =================================================

        if (!Array.isArray(order.items) || order.items.length === 0) {
          result.skippedOrders++;

          continue;
        }

        // =================================================
        // NẾU KHÔNG REPLACE
        // KIỂM TRA HISTORY CŨ
        // =================================================

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

        // =================================================
        // ITEMS
        // =================================================

        for (const item of order.items) {
          result.totalItems++;

          // ===============================================
          // PRODUCT ID
          // ===============================================

          if (!item?.productId) {
            result.skippedItems++;

            continue;
          }

          if (!isValidObjectId(item.productId)) {
            result.skippedItems++;

            continue;
          }

          // ===============================================
          // QTY
          // ===============================================

          const qty = toNumber(item.qty);

          if (qty <= 0) {
            result.skippedItems++;

            continue;
          }

          // ===============================================
          // VARIANT
          // ===============================================

          const variantName = normalizeVariantName(item.variantName);

          // ===============================================
          // CREATE HISTORY
          // ===============================================

          histories.push({
            type: "order",

            referenceType: "Order",

            referenceId: order._id,

            referenceCode: order.code || "",

            productId: item.productId,

            productTitle: item.productTitle || "",

            productCode: getProductCode(item),

            variantName,

            // Xuất kho = số âm
            qty: -Math.abs(qty),

            /*
             * Vì đây là rebuild từ JSON đơn hàng,
             * chưa biết chính xác tồn tại thời điểm
             * đơn được tạo.
             *
             * Tạm lấy giá trị từ JSON nếu có.
             */
            beforeQty: Number.isFinite(Number(item.beforeQty))
              ? Number(item.beforeQty)
              : 0,

            afterQty: Number.isFinite(Number(item.afterQty))
              ? Number(item.afterQty)
              : 0,

            note: `Xuất kho theo đơn hàng ${order.code || order._id}`,

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

      // ===================================================
      // INSERT ALL HISTORY
      // ===================================================

      if (histories.length > 0) {
        const inserted = await InventoryHistory.insertMany(histories, {
          session,

          ordered: true,
        });

        result.createdHistory = inserted.length;
      }
    });

    // =====================================================
    // RESPONSE
    // =====================================================

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
 * EXPORT
 * =========================================================
 */

module.exports = {
  listInventoryHistoryAsync,
  rebuildInventoryHistoryAsync,
};
