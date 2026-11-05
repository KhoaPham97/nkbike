const crypto = require("crypto");
const axios = require("axios");

const ShopeeShop = require("../models/ShopeeShop");

// =====================================================
// 1. CONFIG
// =====================================================

function getShopeeConfig() {
  const partnerId = process.env.SHOPEE_PARTNER_ID;
  const partnerKey = process.env.SHOPEE_PARTNER_KEY;

  if (!partnerId || !partnerKey) {
    throw new Error(
      "Thiếu SHOPEE_PARTNER_ID hoặc SHOPEE_PARTNER_KEY trong .env",
    );
  }

  const environment = String(process.env.SHOPEE_ENV || "sandbox").toLowerCase();

  const defaultBaseUrl =
    environment === "production" || environment === "live"
      ? "https://partner.shopeemobile.com"
      : "https://partner.test-stable.shopeemobile.com";

  return {
    partnerId: Number(partnerId),
    partnerKey: String(partnerKey),

    baseUrl: (process.env.SHOPEE_API_BASE_URL || defaultBaseUrl).replace(
      /\/+$/,
      "",
    ),

    redirectUri: process.env.SHOPEE_REDIRECT_URI,

    timeout: 30000,
  };
}

// =====================================================
// 2. SIGNATURE
// =====================================================

function createSign(baseString, partnerKey) {
  return crypto
    .createHmac("sha256", partnerKey)
    .update(baseString)
    .digest("hex");
}

function createPublicSign(path, timestamp, config) {
  const baseString = String(config.partnerId) + path + String(timestamp);

  return createSign(baseString, config.partnerKey);
}

function createShopSign({ path, timestamp, accessToken, shopId, config }) {
  const baseString =
    String(config.partnerId) +
    path +
    String(timestamp) +
    String(accessToken) +
    String(shopId);

  return createSign(baseString, config.partnerKey);
}

// =====================================================
// 3. AXIOS CLIENT
// =====================================================

function getHttpClient() {
  const config = getShopeeConfig();

  return axios.create({
    baseURL: config.baseUrl,
    timeout: config.timeout,
    headers: {
      "Content-Type": "application/json",
    },
  });
}

function extractShopeeResponse(response) {
  const data = response?.data;

  if (!data) {
    throw new Error("Shopee không trả về dữ liệu");
  }

  if (data.error) {
    throw new Error(data.message || data.error || "Shopee API trả về lỗi");
  }

  return data;
}

// =====================================================
// 4. TẠO URL KẾT NỐI SHOP
//
// GET /api/v2/shop/auth_partner
// =====================================================

async function getShopeeAuthUrl() {
  const config = getShopeeConfig();

  if (!config.redirectUri) {
    throw new Error("Thiếu SHOPEE_REDIRECT_URI trong .env");
  }

  const path = "/api/v2/shop/auth_partner";
  const timestamp = Math.floor(Date.now() / 1000);

  const sign = createPublicSign(path, timestamp, config);

  const url = new URL(config.baseUrl + path);

  url.searchParams.set("partner_id", String(config.partnerId));

  url.searchParams.set("timestamp", String(timestamp));
  url.searchParams.set("sign", sign);
  url.searchParams.set("redirect", config.redirectUri);

  return url.toString();
}

// =====================================================
// 5. LẤY ACCESS TOKEN SAU CALLBACK
//
// POST /api/v2/auth/token/get
// =====================================================

async function exchangeAuthorizationCode({ code, shopId }) {
  const config = getShopeeConfig();

  const path = "/api/v2/auth/token/get";
  const timestamp = Math.floor(Date.now() / 1000);

  const baseString =
    String(config.partnerId) +
    path +
    String(timestamp) +
    String(code) +
    String(shopId);

  const sign = createSign(baseString, config.partnerKey);

  const client = getHttpClient();

  const response = await client.post(path, {
    partner_id: config.partnerId,
    shop_id: Number(shopId),
    code: String(code),
    timestamp,
    sign,
  });

  return extractShopeeResponse(response);
}

// =====================================================
// 6. LƯU TOKEN SHOP
// =====================================================

async function saveShopTokens({
  shopId,
  accessToken,
  refreshToken,
  expireIn,
  rawData,
}) {
  const normalizedShopId = String(shopId);

  const expiresAt = new Date(Date.now() + Number(expireIn || 14400) * 1000);

  const update = {
    shopId: normalizedShopId,
    accessToken,
    refreshToken,
    accessTokenExpiresAt: expiresAt,
    lastTokenUpdatedAt: new Date(),
  };

  // Không lưu token thô vào log.
  if (rawData) {
    update.tokenResponse = {
      shopId: normalizedShopId,
      expireIn: Number(expireIn || 14400),
    };
  }

  const shop = await ShopeeShop.findOneAndUpdate(
    { shopId: normalizedShopId },
    { $set: update },
    {
      new: true,
      upsert: true,
      setDefaultsOnInsert: true,
    },
  );

  return shop;
}

// =====================================================
// 7. CALLBACK SHOPEE
// =====================================================

async function handleShopeeCallback(query = {}) {
  const { code, shop_id: shopId, error, message } = query;

  if (error) {
    throw new Error(message || error || "Người dùng từ chối kết nối Shopee");
  }

  if (!code || !shopId) {
    throw new Error("Callback Shopee thiếu code hoặc shop_id");
  }

  const tokenData = await exchangeAuthorizationCode({
    code,
    shopId,
  });

  const accessToken = tokenData.access_token;
  const refreshToken = tokenData.refresh_token;

  if (!accessToken || !refreshToken) {
    throw new Error("Shopee không trả về access_token hoặc refresh_token");
  }

  const savedShop = await saveShopTokens({
    shopId: tokenData.shop_id || shopId,
    accessToken,
    refreshToken,
    expireIn: tokenData.expire_in,
  });

  return {
    success: true,
    shopId: String(tokenData.shop_id || shopId),
    message: "Kết nối Shopee thành công",
    shop: savedShop,
  };
}

// =====================================================
// 8. LẤY SHOP KÈM TOKEN
// =====================================================

async function getShopWithTokens(shopId) {
  const shop = await ShopeeShop.findOne({
    shopId: String(shopId),
  }).select("+accessToken +refreshToken");

  if (!shop) {
    throw new Error(`Không tìm thấy shop Shopee ${shopId}`);
  }

  if (!shop.refreshToken) {
    throw new Error("Shop chưa có refresh token. Hãy kết nối lại Shopee.");
  }

  return shop;
}

// =====================================================
// 9. REFRESH ACCESS TOKEN
//
// POST /api/v2/auth/access_token/get
//
// Refresh token Shopee có thể được thay mới sau mỗi lần
// refresh. Phải lưu refresh_token mới nhận được.
// =====================================================

async function refreshShopeeAccessToken(shopId) {
  const config = getShopeeConfig();

  const shop = await getShopWithTokens(shopId);

  const path = "/api/v2/auth/access_token/get";
  const timestamp = Math.floor(Date.now() / 1000);

  const baseString =
    String(config.partnerId) +
    path +
    String(timestamp) +
    String(shop.refreshToken) +
    String(shopId);

  const sign = createSign(baseString, config.partnerKey);

  const client = getHttpClient();

  const response = await client.post(path, {
    partner_id: config.partnerId,
    shop_id: Number(shopId),
    refresh_token: shop.refreshToken,
    timestamp,
    sign,
  });

  const tokenData = extractShopeeResponse(response);

  if (!tokenData.access_token || !tokenData.refresh_token) {
    throw new Error(
      "Shopee không trả về token mới. Vui lòng kết nối lại shop.",
    );
  }

  const expiresAt = new Date(
    Date.now() + Number(tokenData.expire_in || 14400) * 1000,
  );

  shop.accessToken = tokenData.access_token;
  shop.refreshToken = tokenData.refresh_token;
  shop.accessTokenExpiresAt = expiresAt;
  shop.lastTokenUpdatedAt = new Date();

  await shop.save();

  return {
    success: true,
    shopId: String(shopId),
    accessTokenExpiresAt: expiresAt,
  };
}

// =====================================================
// 10. ĐẢM BẢO ACCESS TOKEN CÒN HẠN
// =====================================================

async function getValidShopToken(shopId) {
  let shop = await getShopWithTokens(shopId);

  const expiresAt = shop.accessTokenExpiresAt
    ? new Date(shop.accessTokenExpiresAt).getTime()
    : 0;

  const shouldRefresh =
    !shop.accessToken || !expiresAt || expiresAt <= Date.now() + 5 * 60 * 1000;

  if (shouldRefresh) {
    await refreshShopeeAccessToken(shopId);

    shop = await getShopWithTokens(shopId);
  }

  return shop;
}

// =====================================================
// 11. GỌI SHOP API CÓ KÝ
// =====================================================

async function callShopeeShopApi({
  shopId,
  path,
  method = "GET",
  params = {},
  body = {},
}) {
  const config = getShopeeConfig();

  const shop = await getValidShopToken(shopId);

  const timestamp = Math.floor(Date.now() / 1000);

  const sign = createShopSign({
    path,
    timestamp,
    accessToken: shop.accessToken,
    shopId,
    config,
  });

  const authParams = {
    partner_id: config.partnerId,
    timestamp,
    access_token: shop.accessToken,
    shop_id: Number(shopId),
    sign,
  };

  const client = getHttpClient();

  try {
    const response = await client.request({
      url: path,
      method,
      params: {
        ...params,
        ...authParams,
      },
      data: body,
    });

    return extractShopeeResponse(response);
  } catch (error) {
    const responseData = error?.response?.data;

    // Token có thể vừa hết hạn hoặc bị Shopee thu hồi.
    // Chỉ tự refresh và thử lại một lần với lỗi token.
    const errorCode = String(responseData?.error || "").toLowerCase();

    const message = String(responseData?.message || "").toLowerCase();

    const tokenError =
      errorCode.includes("token") || message.includes("access token");

    if (!tokenError) {
      throw error;
    }

    await refreshShopeeAccessToken(shopId);

    const refreshedShop = await getShopWithTokens(shopId);

    const retryTimestamp = Math.floor(Date.now() / 1000);

    const retrySign = createShopSign({
      path,
      timestamp: retryTimestamp,
      accessToken: refreshedShop.accessToken,
      shopId,
      config,
    });

    const retryResponse = await client.request({
      url: path,
      method,
      params: {
        ...params,
        partner_id: config.partnerId,
        timestamp: retryTimestamp,
        access_token: refreshedShop.accessToken,
        shop_id: Number(shopId),
        sign: retrySign,
      },
      data: body,
    });

    return extractShopeeResponse(retryResponse);
  }
}

// =====================================================
// 12. LẤY DANH SÁCH ĐƠN HÀNG
//
// GET /api/v2/order/get_order_list
//
// Chỉ lấy danh sách order_sn và thông tin cơ bản.
// Không lưu MongoDB.
// Không trừ tồn kho.
// =====================================================

async function getShopeeOrders({
  shopId,
  timeFrom,
  timeTo,
  pageSize = 50,
  cursor = "",
  timeRangeField = "create_time",
  orderStatus,
}) {
  if (!shopId) {
    throw new Error("Thiếu shopId");
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
    throw new Error("Khoảng thời gian không hợp lệ");
  }

  if (!["create_time", "update_time"].includes(timeRangeField)) {
    throw new Error("timeRangeField chỉ được là create_time hoặc update_time");
  }

  const limit = Math.min(Math.max(Number(pageSize) || 50, 1), 100);

  const params = {
    time_range_field: timeRangeField,
    time_from: from,
    time_to: to,
    page_size: limit,
    cursor: String(cursor || ""),
  };

  if (orderStatus) {
    params.order_status = orderStatus;
  }

  const path = "/api/v2/order/get_order_list";

  const data = await callShopeeShopApi({
    shopId,
    path,
    method: "GET",
    params,
  });

  const result = data.response || data;

  return {
    requestId: data.request_id || null,

    orderList: result.order_list || [],

    more: Boolean(result.more),

    nextCursor: result.next_cursor || "",

    raw: data,
  };
}

// =====================================================
// 13. EXPORT
// =====================================================

module.exports = {
  getShopeeAuthUrl,
  handleShopeeCallback,
  refreshShopeeAccessToken,
  getShopeeOrders,

  // Có thể dùng lại khi cần gọi API Shopee khác.
  callShopeeShopApi,
};
