const crypto = require("crypto");

const ShopeeShop = require("../models/ShopeeShop");
const ShopeeOAuthState = require("../models/ShopeeOAuthState");

const {
  PARTNER_ID,
  createAuthUrl,
  getAccessToken,
  refreshAccessToken,
  getOrderList,
  getOrderDetail,
} = require("../utils/shopeeApi");

const REDIRECT_URI = process.env.SHOPEE_REDIRECT_URI;
const FRONTEND_URL =
  process.env.SHOPEE_FRONTEND_URL || "https://nk-admin.onrender.com";

// =====================================================
// 1. TẠO LINK OAUTH
// POST /api/shopee/auth
// =====================================================

exports.connectShopee = async (req, res) => {
  try {
    if (!REDIRECT_URI || !PARTNER_ID) {
      return res.status(500).json({
        success: false,
        message: "Thiếu cấu hình Shopee",
      });
    }

    const state = crypto.randomBytes(32).toString("hex");

    await ShopeeOAuthState.create({
      state,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    });

    // Gắn state vào callback URL để xác thực khi Shopee trả về
    const redirectUrl = new URL(REDIRECT_URI);
    redirectUrl.searchParams.set("state", state);

    const authUrl = createAuthUrl(redirectUrl.toString());

    console.log("========== SHOPEE OAUTH ==========");
    console.log("Environment:", process.env.SHOPEE_ENV);
    console.log("Partner ID:", PARTNER_ID);
    console.log("Redirect URI:", REDIRECT_URI);
    console.log(
      "OAuth endpoint:",
      new URL(authUrl).origin + new URL(authUrl).pathname,
    );
    console.log("==================================");

    return res.json({
      success: true,
      authUrl,
    });
  } catch (error) {
    console.error("SHOPEE AUTH:", error.response?.data || error.message);

    return res.status(500).json({
      success: false,
      message: "Không thể tạo link Shopee",
    });
  }
};

// =====================================================
// 2. SHOPEE CALLBACK
// GET /api/shopee/callback
// =====================================================

exports.shopeeCallback = async (req, res) => {
  try {
    const { code, shop_id, state, error } = req.query;

    if (error) {
      return res.redirect(`${FRONTEND_URL}/admin/settings?shopee=failed`);
    }

    if (!code || !shop_id || !state) {
      return res.status(400).send("Missing Shopee OAuth parameters");
    }

    const stateRecord = await ShopeeOAuthState.findOneAndDelete({
      state,
      expiresAt: { $gt: new Date() },
    });

    if (!stateRecord) {
      return res.status(400).send("Invalid or expired OAuth state");
    }

    const shopId = String(shop_id);

    if (!/^\d+$/.test(shopId)) {
      return res.status(400).send("Invalid shop ID");
    }

    const tokenData = await getAccessToken(code, shopId);

    if (!tokenData.access_token || !tokenData.refresh_token) {
      throw new Error("Shopee token response is incomplete");
    }

    const expiresIn = Number(tokenData.expire_in);

    await ShopeeShop.findOneAndUpdate(
      { shopId },
      {
        $set: {
          accessToken: tokenData.access_token,
          refreshToken: tokenData.refresh_token,
          accessTokenExpiresAt: new Date(
            Date.now() + (expiresIn || 14400) * 1000,
          ),
          status: "connected",
          lastConnectedAt: new Date(),
        },
      },
      {
        upsert: true,
        new: true,
        runValidators: true,
      },
    );

    return res.redirect(`${FRONTEND_URL}/admin/settings?shopee=connected`);
  } catch (error) {
    console.error("SHOPEE CALLBACK:", error.response?.data || error.message);

    return res.redirect(`${FRONTEND_URL}/admin/settings?shopee=failed`);
  }
};

// =====================================================
// 3. DANH SÁCH SHOP
// GET /api/shopee/shops
// =====================================================

exports.getShopeeShops = async (req, res) => {
  try {
    const shops = await ShopeeShop.find()
      .select(
        "shopId status accessTokenExpiresAt lastConnectedAt lastRefreshedAt createdAt",
      )
      .sort({ createdAt: -1 })
      .lean();

    return res.json({
      success: true,
      data: shops,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};

// =====================================================
// 4. REFRESH TOKEN
// POST /api/shopee/refresh-token
// =====================================================

exports.refreshShopeeToken = async (req, res) => {
  try {
    const { shopId } = req.body;

    if (!shopId) {
      return res.status(400).json({
        success: false,
        message: "Thiếu shopId",
      });
    }

    const shop = await ShopeeShop.findOne({
      shopId: String(shopId),
      status: "connected",
    }).select("+accessToken +refreshToken");

    if (!shop) {
      return res.status(404).json({
        success: false,
        message: "Không tìm thấy shop Shopee",
      });
    }

    const tokenData = await refreshAccessToken(shop.refreshToken, shop.shopId);

    if (!tokenData.access_token || !tokenData.refresh_token) {
      throw new Error("Invalid refresh response");
    }

    shop.accessToken = tokenData.access_token;
    shop.refreshToken = tokenData.refresh_token;

    shop.accessTokenExpiresAt = new Date(
      Date.now() + Number(tokenData.expire_in || 14400) * 1000,
    );

    shop.refreshTokenExpiresAt = new Date(
      Date.now() + 30 * 24 * 60 * 60 * 1000,
    );

    shop.lastRefreshedAt = new Date();

    await shop.save();

    return res.json({
      success: true,
      message: "Refresh token thành công",
      data: {
        shopId: shop.shopId,
        accessTokenExpiresAt: shop.accessTokenExpiresAt,
      },
    });
  } catch (error) {
    console.error("SHOPEE REFRESH:", error.response?.data || error.message);

    return res.status(500).json({
      success: false,
      message: "Refresh token thất bại",
      error: process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  }
};

// =====================================================
// 5. NGẮT KẾT NỐI SHOP
// DELETE /api/shopee/shops/:shopId
// =====================================================

exports.disconnectShopeeShop = async (req, res) => {
  try {
    const shop = await ShopeeShop.findOneAndUpdate(
      {
        shopId: String(req.params.shopId),
      },
      {
        $set: {
          status: "disconnected",
        },
        $unset: {
          accessToken: 1,
          refreshToken: 1,
        },
      },
      { new: true },
    );

    if (!shop) {
      return res.status(404).json({
        success: false,
        message: "Không tìm thấy shop",
      });
    }

    return res.json({
      success: true,
      message: "Đã ngắt kết nối Shopee",
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};

// =====================================================
// 6. XEM ĐƠN HÀNG SHOPEE
// POST /api/shopee/orders/sync
// Không lưu MongoDB, không trừ tồn kho
// =====================================================

// Chuyển ngày frontend thành Unix timestamp (giây)
const parseShopeeTime = (value, isEnd = false) => {
  if (value === undefined || value === null || value === "") {
    return NaN;
  }

  const str = String(value).trim();

  // Trường hợp YYYY-MM-DD
  const dateMatch = str.match(/^(\d{4})-(\d{2})-(\d{2})$/);

  if (dateMatch) {
    const [, year, month, day] = dateMatch.map(Number);

    // Kiểm tra ngày hợp lệ
    const check = new Date(Date.UTC(year, month - 1, day));

    if (
      check.getUTCFullYear() !== year ||
      check.getUTCMonth() !== month - 1 ||
      check.getUTCDate() !== day
    ) {
      return NaN;
    }

    // Việt Nam UTC+7
    const date = isEnd
      ? new Date(`${str}T23:59:59+07:00`)
      : new Date(`${str}T00:00:00+07:00`);

    return Math.floor(date.getTime() / 1000);
  }

  // Trường hợp Unix timestamp
  if (/^\d+$/.test(str)) {
    const timestamp = Number(str);

    // Nếu là milliseconds thì chuyển sang seconds
    return timestamp > 9999999999 ? Math.floor(timestamp / 1000) : timestamp;
  }

  // Trường hợp ISO datetime
  const parsed = new Date(str).getTime();

  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : NaN;
};

exports.viewShopeeOrders = async (req, res) => {
  try {
    const {
      shopId,
      timeFrom,
      timeTo,
      pageSize = 50,
      cursor = "",
      timeRangeField = "create_time",
      orderStatus,
    } = req.body;

    if (!shopId) {
      return res.status(400).json({
        success: false,
        message: "Vui lòng chọn shop Shopee",
      });
    }

    // 1. Chuyển đổi ngày
    const from = parseShopeeTime(timeFrom, false);
    const to = parseShopeeTime(timeTo, true);

    if (
      !Number.isFinite(from) ||
      !Number.isFinite(to) ||
      from <= 0 ||
      to <= from
    ) {
      return res.status(400).json({
        success: false,
        message: "Khoảng thời gian không hợp lệ",
      });
    }

    // 2. Kiểm tra giới hạn 15 ngày
    if (to - from > 15 * 24 * 60 * 60) {
      return res.status(400).json({
        success: false,
        message: "Mỗi lần xem chỉ được chọn tối đa 15 ngày",
      });
    }

    // 3. Kiểm tra loại thời gian
    if (!["create_time", "update_time"].includes(timeRangeField)) {
      return res.status(400).json({
        success: false,
        message: "timeRangeField không hợp lệ",
      });
    }

    // 4. Tìm shop
    const shop = await ShopeeShop.findOne({
      shopId: String(shopId),
      status: "connected",
    }).select("+accessToken");

    if (!shop) {
      return res.status(404).json({
        success: false,
        message: "Shop Shopee chưa kết nối hoặc không tồn tại",
      });
    }

    // 5. Lấy danh sách mã đơn
    const listResult = await getOrderList(shop.accessToken, shop.shopId, {
      timeFrom: from,
      timeTo: to,
      pageSize: Math.min(Math.max(Number(pageSize) || 50, 1), 100),
      cursor,
      timeRangeField,
      orderStatus,
    });

    const listData = listResult.response || {};

    const orderSnList = (listData.order_list || [])
      .map((item) => item.order_sn)
      .filter(Boolean);

    // 6. Không có đơn hàng
    if (!orderSnList.length) {
      return res.json({
        success: true,
        message: "Không tìm thấy đơn hàng",
        data: [],
        pagination: {
          more: Boolean(listData.more),
          nextCursor: listData.next_cursor || "",
          pageSize: 0,
        },
      });
    }

    // 7. Lấy chi tiết đơn hàng
    const detailResult = await getOrderDetail(
      shop.accessToken,
      shop.shopId,
      orderSnList,
    );

    const orders = detailResult.response?.order_list || [];

    // 8. Trả kết quả
    return res.json({
      success: true,
      message: "Lấy đơn hàng Shopee thành công",
      data: orders,
      pagination: {
        more: Boolean(listData.more),
        nextCursor: listData.next_cursor || "",
        pageSize: orderSnList.length,
      },
    });
  } catch (error) {
    console.error("SHOPEE VIEW ORDERS:", error.response?.data || error.message);

    return res.status(500).json({
      success: false,
      message: "Không thể lấy đơn hàng Shopee",
      error:
        process.env.NODE_ENV === "development"
          ? error.response?.data || error.message
          : undefined,
    });
  }
};
