const ShopeeShop = require("../models/ShopeeShop");

const {
  getShopeeAuthUrl,
  handleShopeeCallback,
  refreshShopeeAccessToken,
  getShopeeOrders,
} = require("../services/shopeeService");

// =====================================================
// HELPERS
// =====================================================

function getMessage(error) {
  return (
    error?.response?.data?.message ||
    error?.response?.data?.error ||
    error?.message ||
    "Đã xảy ra lỗi khi xử lý Shopee"
  );
}

function getAdminId(req) {
  return req.user?._id || req.user?.id || null;
}

// =====================================================
// 1. KẾT NỐI SHOPEE
// POST /api/shopee/auth
// =====================================================

exports.connectShopee = async (req, res) => {
  try {
    const authUrl = await getShopeeAuthUrl({
      userId: getAdminId(req),
    });

    if (!authUrl) {
      return res.status(400).json({
        success: false,
        message: "Không tạo được đường dẫn kết nối Shopee",
      });
    }

    return res.json({
      success: true,
      authUrl,
      url: authUrl,
    });
  } catch (error) {
    console.error("connectShopee:", error);

    return res.status(500).json({
      success: false,
      message: getMessage(error),
    });
  }
};

// =====================================================
// 2. SHOPEE CALLBACK
// GET /api/shopee/callback
//
// Shopee gọi trực tiếp, không yêu cầu JWT.
// =====================================================

exports.shopeeCallback = async (req, res) => {
  try {
    const result = await handleShopeeCallback(req.query);

    const frontendUrl =
      process.env.SHOPEE_FRONTEND_URL || "http://localhost:5173/admin";

    if (result?.success === false) {
      const redirectUrl = new URL(frontendUrl);

      redirectUrl.searchParams.set("shopee", "error");
      redirectUrl.searchParams.set(
        "message",
        result.message || "Kết nối Shopee thất bại",
      );

      return res.redirect(redirectUrl.toString());
    }

    const redirectUrl = new URL(frontendUrl);

    redirectUrl.searchParams.set("shopee", "success");

    if (result?.shopId) {
      redirectUrl.searchParams.set("shopId", String(result.shopId));
    }

    return res.redirect(redirectUrl.toString());
  } catch (error) {
    console.error("shopeeCallback:", error);

    const frontendUrl =
      process.env.SHOPEE_FRONTEND_URL || "http://localhost:5173/admin";

    const redirectUrl = new URL(frontendUrl);

    redirectUrl.searchParams.set("shopee", "error");
    redirectUrl.searchParams.set("message", getMessage(error));

    return res.redirect(redirectUrl.toString());
  }
};

// =====================================================
// 3. DANH SÁCH SHOP ĐÃ KẾT NỐI
// GET /api/shopee/shops
// =====================================================

exports.getShopeeShops = async (req, res) => {
  try {
    const shops = await ShopeeShop.find({})
      .select("-accessToken -refreshToken -refreshTokenExpiresAt")
      .sort({ createdAt: -1 })
      .lean();

    return res.json({
      success: true,
      data: shops,
      shops,
    });
  } catch (error) {
    console.error("getShopeeShops:", error);

    return res.status(500).json({
      success: false,
      message: getMessage(error),
    });
  }
};

// =====================================================
// 4. LÀM MỚI ACCESS TOKEN
// POST /api/shopee/refresh-token
// =====================================================

exports.refreshShopeeToken = async (req, res) => {
  try {
    const { shopId } = req.body;

    if (!shopId) {
      return res.status(400).json({
        success: false,
        message: "Vui lòng cung cấp shopId",
      });
    }

    const result = await refreshShopeeAccessToken(String(shopId));

    return res.json({
      success: true,
      message: "Làm mới token thành công",
      data: result,
    });
  } catch (error) {
    console.error("refreshShopeeToken:", error);

    return res.status(400).json({
      success: false,
      message: getMessage(error),
    });
  }
};

// =====================================================
// 5. NGẮT KẾT NỐI SHOP
// DELETE /api/shopee/shops/:shopId
// =====================================================

exports.disconnectShopeeShop = async (req, res) => {
  try {
    const { shopId } = req.params;

    if (!shopId) {
      return res.status(400).json({
        success: false,
        message: "Thiếu shopId",
      });
    }

    const shop = await ShopeeShop.findOneAndDelete({
      shopId: String(shopId),
    });

    if (!shop) {
      return res.status(404).json({
        success: false,
        message: "Không tìm thấy shop Shopee",
      });
    }

    return res.json({
      success: true,
      message: "Đã ngắt kết nối shop Shopee",
    });
  } catch (error) {
    console.error("disconnectShopeeShop:", error);

    return res.status(500).json({
      success: false,
      message: getMessage(error),
    });
  }
};

// =====================================================
// 6. XEM / ĐỒNG BỘ ĐƠN SHOPEE
// POST /api/shopee/orders/sync
//
// Chỉ lấy dữ liệu để hiển thị.
// Không trừ tồn kho.
// =====================================================

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

    if (!timeFrom || !timeTo) {
      return res.status(400).json({
        success: false,
        message: "Vui lòng chọn khoảng thời gian",
      });
    }

    const from = Number(timeFrom);
    const to = Number(timeTo);

    if (
      !Number.isFinite(from) ||
      !Number.isFinite(to) ||
      from <= 0 ||
      to <= 0 ||
      from > to
    ) {
      return res.status(400).json({
        success: false,
        message: "Khoảng thời gian không hợp lệ",
      });
    }

    const limit = Math.min(Math.max(Number(pageSize) || 50, 1), 100);

    const result = await getShopeeOrders({
      shopId: String(shopId),
      timeFrom: from,
      timeTo: to,
      pageSize: limit,
      cursor: String(cursor || ""),
      timeRangeField,
      orderStatus: orderStatus || undefined,
    });

    return res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    console.error("viewShopeeOrders:", error);

    return res.status(400).json({
      success: false,
      message: getMessage(error),
    });
  }
};
