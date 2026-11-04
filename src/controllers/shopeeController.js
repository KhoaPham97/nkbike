const crypto = require("crypto");

const ShopeeShop = require("../models/ShopeeShop");
const ShopeeOAuthState = require("../models/ShopeeOAuthState");

const {
  PARTNER_ID,
  createAuthUrl,
  getAccessToken,
  refreshAccessToken,
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
