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

  const normalizedShopId = String(shopId);
  const shop = await getShopWithTokens(normalizedShopId);

  if (!shop.refreshToken) {
    throw new Error("Shop không có refresh token");
  }

  const path = "/api/v2/auth/access_token/get";
  const timestamp = Math.floor(Date.now() / 1000);

  // REFRESH TOKEN là Public API.
  // Chỉ ký partner_id + path + timestamp.
  const sign = createPublicSign(path, timestamp, config);

  const client = getHttpClient();

  const response = await client.post(
    path,
    {
      partner_id: Number(config.partnerId),
      shop_id: Number(normalizedShopId),
      refresh_token: shop.refreshToken,
      timestamp,
      sign,
    },
    {
      params: {
        partner_id: Number(config.partnerId),
        timestamp,
        sign,
      },
    },
  );
  const tokenData = extractShopeeResponse(response);

  if (!tokenData.access_token || !tokenData.refresh_token) {
    throw new Error("Shopee không trả về access_token hoặc refresh_token mới");
  }

  const expiresAt = new Date(
    Date.now() + Number(tokenData.expire_in || 14400) * 1000,
  );

  // Shopee cấp refresh_token mới sau mỗi lần refresh.
  shop.accessToken = tokenData.access_token;
  shop.refreshToken = tokenData.refresh_token;
  shop.accessTokenExpiresAt = expiresAt;
  shop.lastTokenUpdatedAt = new Date();

  await shop.save();

  return {
    success: true,
    shopId: normalizedShopId,
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

  // 1. Kiểm tra cấu hình
  if (
    !Number.isSafeInteger(Number(config.partnerId)) ||
    Number(config.partnerId) <= 0
  ) {
    throw new Error("SHOPEE_PARTNER_ID không hợp lệ");
  }

  if (!config.partnerKey) {
    throw new Error("Thiếu SHOPEE_PARTNER_KEY");
  }

  if (!shopId || !Number.isSafeInteger(Number(shopId))) {
    throw new Error("shopId không hợp lệ");
  }

  if (!path || !path.startsWith("/api/v2/")) {
    throw new Error("Shopee API path không hợp lệ");
  }

  const normalizedShopId = String(shopId);

  const client = getHttpClient();

  // 2. Hàm tạo request và ký chữ ký mới
  async function executeRequest(shop) {
    if (!shop?.accessToken) {
      throw new Error("Shop chưa có access token");
    }

    const timestamp = Math.floor(Date.now() / 1000);

    const sign = createShopSign({
      path,
      timestamp,
      accessToken: shop.accessToken,
      shopId: normalizedShopId,
      config,
    });

    // Tham số xác thực luôn được đặt cuối,
    // tránh params bên ngoài ghi đè partner_id hoặc sign.
    const queryParams = {
      ...params,
      partner_id: Number(config.partnerId),
      timestamp,
      access_token: shop.accessToken,
      shop_id: Number(normalizedShopId),
      sign,
    };

    return client.request({
      url: path,
      method,
      params: queryParams,
      data: body,
    });
  }

  // 3. Lấy token còn hạn
  let shop = await getValidShopToken(normalizedShopId);

  try {
    const response = await executeRequest(shop);
    return extractShopeeResponse(response);
  } catch (error) {
    const responseData = error?.response?.data || {};

    const errorCode = String(responseData.error || "").toLowerCase();
    const errorMessage = String(
      responseData.message ||
        responseData.msg ||
        responseData.debug_message ||
        error.message ||
        "",
    ).toLowerCase();

    console.error("SHOPEE API ERROR:", {
      path,
      status: error?.response?.status,
      error: responseData.error,
      message: responseData.message || responseData.msg,
    });

    // 4. Chỉ refresh nếu lỗi thực sự liên quan đến token
    const tokenError =
      errorCode.includes("token") ||
      errorMessage.includes("access token") ||
      errorMessage.includes("invalid access");

    if (!tokenError) {
      throw error;
    }

    // 5. Refresh token
    await refreshShopeeAccessToken(normalizedShopId);

    // 6. Lấy token mới và gửi lại đúng một lần
    shop = await getShopWithTokens(normalizedShopId);

    const retryResponse = await executeRequest(shop);

    return extractShopeeResponse(retryResponse);
  }
}

async function getShopeeOrderDetails(shopId, orderSnList) {
  if (!Array.isArray(orderSnList) || orderSnList.length === 0) {
    return [];
  }

  const path = "/api/v2/order/get_order_detail";

  // Shopee giới hạn tối đa 50 đơn mỗi lần gọi.
  const chunks = [];

  for (let i = 0; i < orderSnList.length; i += 50) {
    chunks.push(orderSnList.slice(i, i + 50));
  }

  const allDetails = [];

  const responseOptionalFields = [
    "buyer_user_id",
    "buyer_username",
    "recipient_address",
    "item_list",
    "total_amount",
    "payment_method",
    "pay_time",
    "package_list",
    "shipping_carrier",
    "actual_shipping_fee",
    "estimated_shipping_fee",
    "buyer_payment_method",
    "dropshipper",
    "dropshipper_phone",
    "note",
    "note_update_time",
  ].join(",");

  for (const chunk of chunks) {
    const data = await callShopeeShopApi({
      shopId,
      path,
      method: "GET",
      params: {
        order_sn_list: chunk.join(","),
        response_optional_fields: responseOptionalFields,
      },
    });

    const result = data.response || data;

    const details = result.order_list || [];

    allDetails.push(...details);
  }

  return allDetails;
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

  // ==========================================
  // BƯỚC 1: LẤY DANH SÁCH ĐƠN
  // ==========================================

  const listData = await callShopeeShopApi({
    shopId,
    path: "/api/v2/order/get_order_list",
    method: "GET",
    params,
  });

  const listResult = listData.response || listData;

  const orderList = listResult.order_list || [];

  // ==========================================
  // BƯỚC 2: LẤY DANH SÁCH order_sn
  // ==========================================

  const orderSnList = orderList.map((order) => order.order_sn).filter(Boolean);

  // ==========================================
  // BƯỚC 3: LẤY CHI TIẾT ĐƠN HÀNG
  // ==========================================

  let detailList = [];

  if (orderSnList.length > 0) {
    detailList = await getShopeeOrderDetails(String(shopId), orderSnList);
  }

  // ==========================================
  // BƯỚC 4: GHÉP THÔNG TIN ĐƠN HÀNG
  // ==========================================

  const detailMap = new Map(
    detailList.map((detail) => [String(detail.order_sn), detail]),
  );

  const mergedOrders = orderList.map((order) => {
    const detail = detailMap.get(String(order.order_sn));

    if (!detail) {
      return order;
    }

    return {
      ...order,
      ...detail,
      // Giữ timestamp gốc từ API danh sách đơn.
      create_time: order.create_time ?? detail.create_time,

      // Ưu tiên thời gian cập nhật mới nhất từ API chi tiết.
      update_time: detail.update_time ?? order.update_time,
    };
  });

  // ==========================================
  // BƯỚC 5: TRẢ KẾT QUẢ
  // ==========================================

  return {
    requestId: listData.request_id || null,

    orderList: mergedOrders,

    detailCount: detailList.length,

    more: Boolean(listResult.more),

    nextCursor: listResult.next_cursor || "",

    raw: {
      orderList: listData,
      orderDetails: detailList,
    },
  };
}
// =====================================================
// 13. LẤY DANH SÁCH SẢN PHẨM SHOPEE
//
// GET /api/v2/product/get_item_list
// GET /api/v2/product/get_item_base_info
// GET /api/v2/product/get_model_list
//
// Không ghi dữ liệu vào MongoDB.
// Không thay đổi tồn kho.
// =====================================================

/**
 * Lấy danh sách item_id theo từng trang.
 */
async function getShopeeItemIds({
  shopId,
  itemStatuses = ["NORMAL"],
  pageSize = 100,
  maxPages = 1000,
}) {
  if (!shopId) {
    throw new Error("Thiếu shopId khi lấy sản phẩm Shopee");
  }

  const statuses = Array.isArray(itemStatuses) ? itemStatuses : [itemStatuses];

  const allItems = new Map();

  for (const status of statuses) {
    let offset = 0;
    let page = 0;

    while (page < maxPages) {
      const data = await callShopeeShopApi({
        shopId,
        path: "/api/v2/product/get_item_list",
        method: "GET",
        params: {
          offset,
          page_size: Math.min(Math.max(Number(pageSize) || 100, 1), 100),
          item_status: status,
        },
      });

      const result = data.response || data;
      const items = result.item || result.item_list || [];

      for (const item of items) {
        if (item.item_id) {
          allItems.set(String(item.item_id), {
            itemId: String(item.item_id),
            itemStatus: item.item_status || status,
            updateTime: item.update_time || null,
          });
        }
      }

      page += 1;

      if (!result.has_next_page) {
        break;
      }

      const nextOffset = Number(result.next_offset);

      if (!Number.isFinite(nextOffset) || nextOffset === offset) {
        throw new Error(
          `Shopee phân trang sản phẩm không hợp lệ tại offset ${offset}`,
        );
      }

      offset = nextOffset;
    }

    if (page >= maxPages) {
      throw new Error(
        `Đã vượt quá giới hạn ${maxPages} trang khi lấy sản phẩm Shopee`,
      );
    }
  }

  return Array.from(allItems.values());
}

/**
 * Lấy thông tin cơ bản của nhiều sản phẩm.
 * Shopee giới hạn tối đa 50 item_id mỗi lần gọi.
 */
async function getShopeeItemBaseInfo(shopId, itemIds) {
  if (!Array.isArray(itemIds) || itemIds.length === 0) {
    return [];
  }

  const chunks = [];

  for (let i = 0; i < itemIds.length; i += 50) {
    chunks.push(itemIds.slice(i, i + 50));
  }

  const allItems = [];

  for (const chunk of chunks) {
    const data = await callShopeeShopApi({
      shopId,
      path: "/api/v2/product/get_item_base_info",
      method: "GET",
      params: {
        item_id_list: chunk.join(","),
        response_optional_fields: [
          "item_sku",
          "model",
          "has_model",
          "description",
          "condition",
          "weight",
          "dimension",
          "image",
          "brand",
        ].join(","),
      },
    });

    const result = data.response || data;
    const items = result.item_list || [];

    allItems.push(...items);
  }

  return allItems;
}

/**
 * Lấy danh sách model/biến thể của một sản phẩm.
 */
async function getShopeeItemModels(shopId, itemId) {
  const data = await callShopeeShopApi({
    shopId,
    path: "/api/v2/product/get_model_list",
    method: "GET",
    params: {
      item_id: Number(itemId),
    },
  });

  const result = data.response || data;

  return {
    tierVariation: result.tier_variation || [],
    models: (result.model || []).map((model) => ({
      modelId: String(model.model_id || ""),
      modelName: model.model_name || "",
      modelSku: model.model_sku || "",
      modelStatus: model.model_status || "",
      tierIndex: model.tier_index || [],
    })),
  };
}

/**
 * Lấy toàn bộ sản phẩm và SKU biến thể của một shop.
 *
 * Kết quả chuẩn hóa:
 * {
 *   itemId,
 *   itemName,
 *   itemSku,
 *   itemStatus,
 *   hasModel,
 *   models: [
 *     {
 *       modelId,
 *       modelName,
 *       modelSku,
 *       modelStatus
 *     }
 *   ]
 * }
 */
async function getShopeeProducts({
  shopId,
  itemStatuses = ["NORMAL"],
  pageSize = 100,
  maxPages = 1000,
  includeModels = true,
}) {
  if (!shopId) {
    throw new Error("Vui lòng chọn shop Shopee.");
  }

  // Bước 1: Lấy toàn bộ ID sản phẩm.
  const itemIdList = await getShopeeItemIds({
    shopId,
    itemStatuses,
    pageSize,
    maxPages,
  });

  if (itemIdList.length === 0) {
    return {
      shopId: String(shopId),
      total: 0,
      products: [],
    };
  }

  // Bước 2: Lấy thông tin cơ bản.
  const baseItems = await getShopeeItemBaseInfo(
    shopId,
    itemIdList.map((item) => item.itemId),
  );

  const statusMap = new Map(
    itemIdList.map((item) => [item.itemId, item.itemStatus]),
  );

  // Bước 3: Lấy SKU model nếu sản phẩm có phân loại.
  const products = [];

  for (const item of baseItems) {
    const itemId = String(item.item_id || "");

    if (!itemId) continue;

    let models = [];
    let tierVariation = [];

    if (includeModels && item.has_model) {
      const modelData = await getShopeeItemModels(shopId, itemId);

      models = modelData.models;
      tierVariation = modelData.tierVariation;
    }

    products.push({
      itemId,
      itemName: item.item_name || "",
      itemSku: item.item_sku || "",
      itemStatus: item.item_status || statusMap.get(itemId) || "",
      hasModel: Boolean(item.has_model),
      models,
      tierVariation,
    });
  }

  return {
    shopId: String(shopId),
    total: products.length,
    products,
  };
}
// =====================================================
// 14. SHOPEE FINANCE / REVENUE
// =====================================================

// Tổng quan tiền chờ và tiền đã quyết toán.
// Đây là snapshot tại thời điểm gọi, không phải báo cáo lịch sử.
async function getShopeeIncomeOverview(shopId, incomeStatus) {
  const params = {};

  if (incomeStatus !== undefined && incomeStatus !== null) {
    params.income_status = Number(incomeStatus);
  }

  const data = await callShopeeShopApi({
    shopId,
    path: "/api/v2/payment/get_income_overview",
    method: "GET",
    params,
  });

  return data.response || data;
}

// Chi tiết doanh thu theo trạng thái.
// Local shop: 1 = Released, 2 = Pending.
// Released yêu cầu date_from/date_to và tối đa 14 ngày.
async function getShopeeIncomeDetail(
  shopId,
  { incomeStatus, dateFrom, dateTo, pageSize = 100, cursor = "" } = {},
) {
  const status = Number(incomeStatus);

  if (![0, 1, 2].includes(status)) {
    throw new Error("incomeStatus phải là 0, 1 hoặc 2.");
  }

  const size = Math.min(Math.max(Number(pageSize) || 100, 1), 100);

  const params = {
    income_status: status,
    page_size: size,
    cursor: String(cursor || ""),
  };

  if (status === 1) {
    if (!dateFrom || !dateTo) {
      throw new Error("Released cần dateFrom và dateTo.");
    }

    const from = new Date(`${dateFrom}T00:00:00Z`);
    const to = new Date(`${dateTo}T00:00:00Z`);

    if (
      Number.isNaN(from.getTime()) ||
      Number.isNaN(to.getTime()) ||
      from >= to
    ) {
      throw new Error("Khoảng ngày quyết toán không hợp lệ.");
    }

    const days = (to.getTime() - from.getTime()) / 86400000;

    if (days > 13) {
      throw new Error("Mỗi lần lấy Released chỉ được tối đa 14 ngày.");
    }

    params.date_from = dateFrom;
    params.date_to = dateTo;
  }

  // Pending: không truyền ngày, Shopee trả các khoản đang chờ hiện tại.
  const data = await callShopeeShopApi({
    shopId,
    path: "/api/v2/payment/get_income_detail",
    method: "GET",
    params,
  });

  return data.response || data;
}

// Chi tiết hạch toán của một đơn.
async function getShopeeEscrowDetail(shopId, orderSn) {
  if (!orderSn) {
    throw new Error("Thiếu orderSn khi lấy escrow detail.");
  }

  const data = await callShopeeShopApi({
    shopId,
    path: "/api/v2/payment/get_escrow_detail",
    method: "GET",
    params: {
      order_sn: String(orderSn),
    },
  });

  return data.response || data;
}

// Tên hàm Batch để tương thích export hiện tại.
// Dùng endpoint chi tiết từng đơn; giới hạn đồng thời để tránh gọi dồn.
async function getShopeeEscrowDetailBatch(shopId, orderSnList = []) {
  const uniqueOrderSns = [
    ...new Set(
      orderSnList.map((value) => String(value || "").trim()).filter(Boolean),
    ),
  ];

  const results = [];
  const concurrency = 3;

  for (let i = 0; i < uniqueOrderSns.length; i += concurrency) {
    const chunk = uniqueOrderSns.slice(i, i + concurrency);

    const chunkResults = await Promise.all(
      chunk.map(async (orderSn) => {
        try {
          const detail = await getShopeeEscrowDetail(shopId, orderSn);

          return {
            orderSn,
            success: true,
            data: detail,
          };
        } catch (error) {
          return {
            orderSn,
            success: false,
            error: error.message || String(error),
          };
        }
      }),
    );

    results.push(...chunkResults);
  }

  return results;
}
// =====================================================
// 13. EXPORT
// =====================================================

module.exports = {
  getShopeeAuthUrl,
  handleShopeeCallback,
  refreshShopeeAccessToken,
  getShopeeOrders,

  // Sản phẩm và SKU Shopee
  getShopeeProducts,
  getShopeeItemIds,
  getShopeeItemBaseInfo,
  getShopeeItemModels,
  // Shopee Finance / Revenue
  getShopeeIncomeOverview,
  getShopeeIncomeDetail,
  getShopeeEscrowDetail,
  getShopeeEscrowDetailBatch,

  // Gọi API Shopee khác
  callShopeeShopApi,
};
