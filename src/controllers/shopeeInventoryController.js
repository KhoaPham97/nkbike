const mongoose = require("mongoose");

const ShopeeOrder = require("../models/ShopeeOrder");
const ShopeeReturn = require("../models/ShopeeReturn");
const ShopeeStockTransaction = require("../models/ShopeeStockTransaction");

const {
  exportShopeeOrderItem,
  restockShopeeReturnItem,
} = require("../services/shopeeInventoryService");

// =====================================================
// HELPERS
// =====================================================

function getMessage(error) {
  if (error.code === 11000) {
    return "Giao dịch đã được xử lý trước đó";
  }

  return error.message || "Có lỗi xảy ra";
}

function validObjectId(value) {
  return mongoose.isValidObjectId(value);
}

function getCreatedBy(req) {
  return req.user?._id || null;
}

function validRequestId(value) {
  const id = String(value || "").trim();

  return id.length >= 8 && id.length <= 100;
}

function makeItemKey(itemId, modelId) {
  return `${String(itemId)}_${String(modelId || "0")}`;
}

// =====================================================
// 1. XÁC NHẬN XUẤT KHO ĐƠN SHOPEE
// POST /api/shopee/inventory/orders/:orderSn/export
// =====================================================

exports.exportOrderItem = async (req, res) => {
  try {
    const {
      shopId,
      itemKey,
      productId,
      variantCode,
      qty,
      requestId,
      note = "",
    } = req.body;

    const orderSn = String(req.params.orderSn || "").trim();

    if (
      !shopId ||
      !orderSn ||
      !itemKey ||
      !productId ||
      !variantCode ||
      !requestId
    ) {
      return res.status(400).json({
        success: false,
        message: "Thiếu thông tin xuất kho",
      });
    }

    if (!validRequestId(requestId)) {
      return res.status(400).json({
        success: false,
        message: "requestId không hợp lệ",
      });
    }

    if (!validObjectId(productId)) {
      return res.status(400).json({
        success: false,
        message: "productId không hợp lệ",
      });
    }

    const quantity = Number(qty);

    if (!Number.isInteger(quantity) || quantity <= 0) {
      return res.status(400).json({
        success: false,
        message: "Số lượng xuất phải là số nguyên dương",
      });
    }

    // Kiểm tra sơ bộ ngoài transaction.
    // Service vẫn phải kiểm tra lại để đảm bảo an toàn.
    const order = await ShopeeOrder.findOne({
      shopId: String(shopId),
      orderSn,
    }).lean();

    if (!order) {
      return res.status(404).json({
        success: false,
        message: "Không tìm thấy đơn Shopee",
      });
    }

    const item = (order.items || []).find(
      (row) => makeItemKey(row.itemId, row.modelId) === String(itemKey),
    );

    if (!item) {
      return res.status(404).json({
        success: false,
        message: "Không tìm thấy sản phẩm trong đơn",
      });
    }

    if (
      item.mappingStatus !== "mapped" ||
      String(item.productId) !== String(productId) ||
      String(item.variantCode) !== String(variantCode)
    ) {
      return res.status(400).json({
        success: false,
        message: "Sản phẩm trong đơn chưa được ánh xạ đúng SKU",
      });
    }

    const orderStatus = String(order.orderStatus || "").toUpperCase();

    if (["CANCELLED", "IN_CANCEL"].includes(orderStatus)) {
      return res.status(400).json({
        success: false,
        message: "Đơn đã hủy hoặc đang chờ hủy, không thể xuất kho",
      });
    }

    const idempotencyKey = `SHOPEE:ORDER:${shopId}:${orderSn}:${itemKey}:${requestId}`;

    const result = await exportShopeeOrderItem({
      shopId: String(shopId),
      orderSn,
      itemKey,
      productId,
      variantCode,
      qty: quantity,
      idempotencyKey,
      createdBy: getCreatedBy(req),
      note: String(note || "").trim(),
    });

    return res.json({
      success: true,
      message: result.alreadyProcessed
        ? "Giao dịch này đã được xử lý trước đó"
        : "Đã xuất kho thành công",
      data: result,
    });
  } catch (error) {
    console.error("SHOPEE EXPORT INVENTORY:", error);

    return res.status(error.code === 11000 ? 409 : 400).json({
      success: false,
      message: getMessage(error),
    });
  }
};

// =====================================================
// 2. NHẬN VÀ KIỂM TRA HÀNG HOÀN
// POST /api/shopee/inventory/returns/:returnSn/receive
// =====================================================

exports.receiveReturnItem = async (req, res) => {
  try {
    const {
      shopId,
      itemKey,
      receivedQty,
      goodQty,
      damagedQty,
      requestId,
      note = "",
    } = req.body;

    const returnSn = String(req.params.returnSn || "").trim();

    if (!shopId || !returnSn || !itemKey || !requestId) {
      return res.status(400).json({
        success: false,
        message: "Thiếu thông tin nhận hàng hoàn",
      });
    }

    if (!validRequestId(requestId)) {
      return res.status(400).json({
        success: false,
        message: "requestId không hợp lệ",
      });
    }

    const received = Number(receivedQty);
    const good = Number(goodQty);
    const damaged = Number(damagedQty);

    if (
      !Number.isInteger(received) ||
      !Number.isInteger(good) ||
      !Number.isInteger(damaged) ||
      received <= 0 ||
      good < 0 ||
      damaged < 0 ||
      good + damaged !== received
    ) {
      return res.status(400).json({
        success: false,
        message: "Số lượng nhận, hàng tốt và hàng hỏng không hợp lệ",
      });
    }

    const returnDoc = await ShopeeReturn.findOne({
      shopId: String(shopId),
      returnSn,
    }).lean();

    if (!returnDoc) {
      return res.status(404).json({
        success: false,
        message: "Không tìm thấy phiếu trả hàng",
      });
    }

    const item = (returnDoc.items || []).find(
      (row) => makeItemKey(row.itemId, row.modelId) === String(itemKey),
    );

    if (!item) {
      return res.status(404).json({
        success: false,
        message: "Không tìm thấy sản phẩm trong phiếu hoàn",
      });
    }

    if (good > 0) {
      if (
        item.mappingStatus !== "mapped" ||
        !item.productId ||
        !item.variantCode
      ) {
        return res.status(400).json({
          success: false,
          message: "Cần ánh xạ SKU chính xác trước khi nhập hàng tốt vào kho",
        });
      }

      if (!validObjectId(item.productId)) {
        return res.status(400).json({
          success: false,
          message: "productId của sản phẩm hoàn không hợp lệ",
        });
      }
    }

    const idempotencyKey = `SHOPEE:RETURN:${shopId}:${returnSn}:${itemKey}:${requestId}`;

    const result = await restockShopeeReturnItem({
      shopId: String(shopId),
      returnSn,
      itemKey,
      receivedQty: received,
      goodQty: good,
      damagedQty: damaged,
      idempotencyKey,
      createdBy: getCreatedBy(req),
      note: String(note || "").trim(),
    });

    return res.json({
      success: true,
      message: result.alreadyProcessed
        ? "Lần nhận hàng này đã được xử lý trước đó"
        : "Đã ghi nhận hàng hoàn",
      data: result,
    });
  } catch (error) {
    console.error("SHOPEE RECEIVE RETURN:", error);

    return res.status(error.code === 11000 ? 409 : 400).json({
      success: false,
      message: getMessage(error),
    });
  }
};

// =====================================================
// 3. LỊCH SỬ GIAO DỊCH KHO SHOPEE
// GET /api/shopee/inventory/transactions
// =====================================================

exports.getTransactions = async (req, res) => {
  try {
    const { shopId, orderSn, returnSn, page = 1, limit = 20 } = req.query;

    if (!shopId) {
      return res.status(400).json({
        success: false,
        message: "Thiếu shopId",
      });
    }

    const currentPage = Math.max(1, parseInt(page, 10) || 1);
    const pageLimit = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));

    const filter = {
      shopId: String(shopId),
    };

    if (orderSn) filter.orderSn = String(orderSn).trim();
    if (returnSn) filter.returnSn = String(returnSn).trim();

    const [data, total] = await Promise.all([
      ShopeeStockTransaction.find(filter)
        .sort({ createdAt: -1, _id: -1 })
        .skip((currentPage - 1) * pageLimit)
        .limit(pageLimit)
        .lean(),

      ShopeeStockTransaction.countDocuments(filter),
    ]);

    return res.json({
      success: true,
      data,
      pagination: {
        page: currentPage,
        limit: pageLimit,
        total,
        totalPages: Math.ceil(total / pageLimit),
      },
    });
  } catch (error) {
    console.error("SHOPEE INVENTORY TRANSACTIONS:", error);

    return res.status(500).json({
      success: false,
      message: getMessage(error),
    });
  }
};
