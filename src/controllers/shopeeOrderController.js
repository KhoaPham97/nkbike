const mongoose = require("mongoose");

const ShopeeShop = require("../models/ShopeeShop");
const ShopeeOrder = require("../models/ShopeeOrder");

const {
  syncAllShopeeOrders,
  syncOneShop,
} = require("../services/shopeeAutoSyncService");

// =====================================================
// HELPERS
// =====================================================

const toNumber = (value, fallback = 0) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
};

const escapeRegex = (value) => {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
};

const normalizeStatus = (value) => {
  return String(value || "")
    .trim()
    .toUpperCase();
};

const normalizeShopId = (value) => {
  return String(value || "").trim();
};

const buildPagination = (page, limit) => {
  const currentPage = Math.max(toNumber(page, 1), 1);
  const currentLimit = Math.min(Math.max(toNumber(limit, 20), 1), 100);

  return {
    page: currentPage,
    limit: currentLimit,
    skip: (currentPage - 1) * currentLimit,
  };
};

// =====================================================
// 1. SYNC SHOPEE ORDERS
// =====================================================
//
// POST /api/shopee/orders/sync
//
// Body:
// {
//   "shopId": "123456789"
// }
//
// Không truyền shopId => đồng bộ tất cả shop connected.
//
// =====================================================

const syncOrdersAsync = async (req, res) => {
  try {
    const shopId = normalizeShopId(req.body?.shopId);

    // -------------------------------------------------
    // SYNC ONE SHOP
    // -------------------------------------------------

    if (shopId) {
      const shop = await ShopeeShop.findOne({
        shopId,
        status: "connected",
      }).lean();

      if (!shop) {
        return res.status(404).json({
          success: false,
          message: "Không tìm thấy shop Shopee đang kết nối",
        });
      }

      const result = await syncOneShop(shop);

      return res.status(200).json({
        success: true,
        message: "Đồng bộ đơn Shopee hoàn tất",
        result,
      });
    }

    // -------------------------------------------------
    // SYNC ALL CONNECTED SHOPS
    // -------------------------------------------------

    const results = await syncAllShopeeOrders();

    const summary = {
      totalShops: results.length,
      fetched: 0,
      saved: 0,
      reserved: 0,
      deducted: 0,
      released: 0,
      failedShops: 0,
      failedOrders: 0,
    };

    for (const result of results) {
      summary.fetched += toNumber(result.fetched);
      summary.saved += toNumber(result.saved);
      summary.reserved += toNumber(result.reserved);
      summary.deducted += toNumber(result.deducted);
      summary.released += toNumber(result.released);

      if (result.error) {
        summary.failedShops++;
      }

      if (Array.isArray(result.errors)) {
        summary.failedOrders += result.errors.length;
      }
    }

    return res.status(200).json({
      success: true,
      message: "Đồng bộ tất cả shop Shopee hoàn tất",
      summary,
      results,
    });
  } catch (error) {
    console.error("syncOrdersAsync:", error);

    return res.status(500).json({
      success: false,
      message: error.message || "Không thể đồng bộ đơn Shopee",
    });
  }
};

// =====================================================
// 2. GET SHOPEE ORDERS
// =====================================================
//
// GET /api/shopee/orders
//
// Query:
// shopId
// page
// limit
// search
// orderStatus
// stockStatus
// from
// to
//
// from/to: Unix timestamp (seconds)
//
// =====================================================

const getOrdersAsync = async (req, res) => {
  try {
    const {
      shopId,
      page = 1,
      limit = 20,
      search = "",
      orderStatus,
      stockStatus,
      from,
      to,
    } = req.query;

    const pagination = buildPagination(page, limit);

    const filter = {};

    // -------------------------------------------------
    // SHOP FILTER
    // -------------------------------------------------

    if (shopId) {
      filter.shopId = normalizeShopId(shopId);
    }

    // -------------------------------------------------
    // ORDER STATUS
    // -------------------------------------------------

    if (orderStatus && orderStatus !== "all") {
      filter.orderStatus = normalizeStatus(orderStatus);
    }

    // -------------------------------------------------
    // STOCK STATUS
    // -------------------------------------------------

    if (stockStatus && stockStatus !== "all") {
      filter.stockStatus = stockStatus;
    }

    // -------------------------------------------------
    // TIME FILTER
    // -------------------------------------------------

    const fromTime = toNumber(from, 0);
    const toTime = toNumber(to, 0);

    if (fromTime > 0 || toTime > 0) {
      filter.createTime = {};

      if (fromTime > 0) {
        filter.createTime.$gte = fromTime;
      }

      if (toTime > 0) {
        filter.createTime.$lte = toTime;
      }
    }

    // -------------------------------------------------
    // SEARCH
    // -------------------------------------------------

    const keyword = String(search || "").trim();

    if (keyword) {
      const regex = new RegExp(escapeRegex(keyword), "i");

      filter.$or = [
        { orderSn: regex },
        { buyerUsername: regex },
        { buyerUserId: regex },
        { recipientName: regex },
        { recipientPhone: regex },
        { recipientAddress: regex },
        { shippingCarrier: regex },
        { "items.itemName": regex },
        { "items.itemSku": regex },
        { "items.variationSku": regex },
        { "items.variantCode": regex },
      ];
    }

    // -------------------------------------------------
    // QUERY
    // -------------------------------------------------

    const [orders, total] = await Promise.all([
      ShopeeOrder.find(filter)
        .sort({
          createTime: -1,
          _id: -1,
        })
        .skip(pagination.skip)
        .limit(pagination.limit)
        .lean(),

      ShopeeOrder.countDocuments(filter),
    ]);

    const totalPages = Math.max(Math.ceil(total / pagination.limit), 1);

    return res.status(200).json({
      success: true,
      orders,
      pagination: {
        total,
        page: pagination.page,
        limit: pagination.limit,
        totalPages,
        hasMore: pagination.page < totalPages,
      },
    });
  } catch (error) {
    console.error("getOrdersAsync:", error);

    return res.status(500).json({
      success: false,
      message: error.message || "Không thể lấy danh sách đơn Shopee",
    });
  }
};

// =====================================================
// 3. GET ORDER DETAIL
// =====================================================
//
// GET /api/shopee/orders/:orderSn
//
// Query:
// shopId (optional)
//
// =====================================================

const getOrderDetailAsync = async (req, res) => {
  try {
    const orderSn = String(req.params.orderSn || "").trim();

    const shopId = normalizeShopId(req.query.shopId);

    if (!orderSn) {
      return res.status(400).json({
        success: false,
        message: "Thiếu mã đơn Shopee",
      });
    }

    const filter = { orderSn };

    if (shopId) {
      filter.shopId = shopId;
    }

    const order = await ShopeeOrder.findOne(filter).lean();

    if (!order) {
      return res.status(404).json({
        success: false,
        message: "Không tìm thấy đơn Shopee",
      });
    }

    return res.status(200).json({
      success: true,
      order,
    });
  } catch (error) {
    console.error("getOrderDetailAsync:", error);

    return res.status(500).json({
      success: false,
      message: error.message || "Không thể lấy chi tiết đơn Shopee",
    });
  }
};

// =====================================================
// 4. GET SYNC STATUS
// =====================================================
//
// GET /api/shopee/sync/status
//
// Trả về:
// - Danh sách shop
// - Số đơn từng shop
// - Thời gian đồng bộ gần nhất
// - Thống kê trạng thái đơn
// - Thống kê trạng thái kho
//
// =====================================================

const getSyncStatusAsync = async (req, res) => {
  try {
    const shops = await ShopeeShop.find({
      status: "connected",
    }).lean();

    const shopIds = shops.map((shop) => String(shop.shopId));

    const [totalOrders, orderStatusStats, stockStatusStats, latestOrder] =
      await Promise.all([
        ShopeeOrder.countDocuments({
          shopId: { $in: shopIds },
        }),

        ShopeeOrder.aggregate([
          {
            $match: {
              shopId: { $in: shopIds },
            },
          },
          {
            $group: {
              _id: "$orderStatus",
              count: { $sum: 1 },
            },
          },
        ]),

        ShopeeOrder.aggregate([
          {
            $match: {
              shopId: { $in: shopIds },
            },
          },
          {
            $group: {
              _id: "$stockStatus",
              count: { $sum: 1 },
            },
          },
        ]),

        ShopeeOrder.findOne({
          shopId: { $in: shopIds },
        })
          .sort({ lastSyncedAt: -1 })
          .select("shopId orderSn lastSyncedAt")
          .lean(),
      ]);

    // -------------------------------------------------
    // ORDER COUNTS BY SHOP
    // -------------------------------------------------

    const shopOrderStats = await ShopeeOrder.aggregate([
      {
        $match: {
          shopId: { $in: shopIds },
        },
      },
      {
        $group: {
          _id: "$shopId",
          totalOrders: { $sum: 1 },
          lastSyncedAt: { $max: "$lastSyncedAt" },
        },
      },
    ]);

    const shopStatsMap = new Map(
      shopOrderStats.map((item) => [String(item._id), item]),
    );

    const shopResults = shops.map((shop) => {
      const stats = shopStatsMap.get(String(shop.shopId));

      return {
        shopId: String(shop.shopId),
        shopName: shop.shopName || shop.shop_name || "",
        status: shop.status,
        totalOrders: stats?.totalOrders || 0,
        lastSyncedAt: stats?.lastSyncedAt || null,
      };
    });

    const toStatsObject = (items) => {
      return items.reduce((result, item) => {
        result[item._id || "unknown"] = item.count;
        return result;
      }, {});
    };

    return res.status(200).json({
      success: true,

      summary: {
        connectedShops: shops.length,
        totalOrders,

        lastSyncedAt: latestOrder?.lastSyncedAt || null,

        orderStatus: toStatsObject(orderStatusStats),

        stockStatus: toStatsObject(stockStatusStats),
      },

      shops: shopResults,
    });
  } catch (error) {
    console.error("getSyncStatusAsync:", error);

    return res.status(500).json({
      success: false,
      message: error.message || "Không thể lấy trạng thái đồng bộ Shopee",
    });
  }
};

// =====================================================
// EXPORT
// =====================================================

module.exports = {
  syncOrdersAsync,
  getOrdersAsync,
  getOrderDetailAsync,
  getSyncStatusAsync,
};
