const crypto = require("crypto");
const axios = require("axios");

const PARTNER_ID = Number(process.env.SHOPEE_PARTNER_ID);
const PARTNER_KEY = process.env.SHOPEE_PARTNER_KEY;

const IS_SANDBOX = process.env.SHOPEE_ENV === "sandbox";

const SHOPEE_HOST = IS_SANDBOX
  ? "https://partner.test-stable.shopeemobile.com"
  : "https://partner.shopeemobile.com";

function validateConfig() {
  if (!Number.isSafeInteger(PARTNER_ID) || PARTNER_ID <= 0 || !PARTNER_KEY) {
    throw new Error("Shopee Partner configuration is invalid");
  }
}

function createSign(path, timestamp) {
  validateConfig();

  return crypto
    .createHmac("sha256", PARTNER_KEY)
    .update(`${PARTNER_ID}${path}${timestamp}`)
    .digest("hex");
}

function createShopSign(path, timestamp, accessToken, shopId) {
  validateConfig();

  return crypto
    .createHmac("sha256", PARTNER_KEY)
    .update(`${PARTNER_ID}${path}${timestamp}${accessToken}${shopId}`)
    .digest("hex");
}

function createAuthUrl(redirectUri) {
  validateConfig();

  const path = "/api/v2/shop/auth_partner";
  const timestamp = Math.floor(Date.now() / 1000);
  const sign = createSign(path, timestamp);

  const params = new URLSearchParams({
    partner_id: String(PARTNER_ID),
    timestamp: String(timestamp),
    sign,
    redirect: redirectUri,
  });

  return `${SHOPEE_HOST}${path}?${params.toString()}`;
}

function throwShopeeError(data) {
  if (data?.error) {
    throw new Error(
      `${data.error}: ${data.message || data.msg || data.debug_message || ""}`,
    );
  }
}

async function publicPost(path, body) {
  validateConfig();

  const timestamp = Math.floor(Date.now() / 1000);
  const sign = createSign(path, timestamp);

  const response = await axios.post(
    `${SHOPEE_HOST}${path}`,
    {
      ...body,
      partner_id: PARTNER_ID,
    },
    {
      params: {
        partner_id: PARTNER_ID,
        timestamp,
        sign,
      },
      timeout: 30000,
    },
  );

  throwShopeeError(response.data);
  return response.data;
}

async function shopGet(path, accessToken, shopId, query = {}) {
  validateConfig();

  if (!accessToken || !shopId) {
    throw new Error("Thiếu accessToken hoặc shopId");
  }

  const timestamp = Math.floor(Date.now() / 1000);
  const sign = createShopSign(path, timestamp, accessToken, shopId);

  const response = await axios.get(`${SHOPEE_HOST}${path}`, {
    params: {
      partner_id: PARTNER_ID,
      timestamp,
      access_token: accessToken,
      shop_id: Number(shopId),
      sign,
      ...query,
    },
    timeout: 30000,
  });

  throwShopeeError(response.data);
  return response.data;
}

async function getOrderList(
  accessToken,
  shopId,
  {
    timeFrom,
    timeTo,
    pageSize = 50,
    cursor = "",
    timeRangeField = "create_time",
    orderStatus,
  },
) {
  const path = "/api/v2/order/get_order_list";

  const query = {
    time_range_field: timeRangeField,
    time_from: Number(timeFrom),
    time_to: Number(timeTo),
    page_size: Math.min(Math.max(Number(pageSize) || 50, 1), 100),
    cursor: cursor || "",
    response_optional_fields: "order_status",
  };

  if (orderStatus) query.order_status = orderStatus;

  return shopGet(path, accessToken, shopId, query);
}

async function getOrderDetail(accessToken, shopId, orderSnList) {
  if (!Array.isArray(orderSnList) || orderSnList.length === 0) {
    return { response: { order_list: [] } };
  }

  if (orderSnList.length > 50) {
    throw new Error("Mỗi lần chỉ lấy tối đa 50 đơn hàng");
  }

  const path = "/api/v2/order/get_order_detail";

  const optionalFields = [
    "buyer_user_id",
    "buyer_username",
    "estimated_shipping_fee",
    "recipient_address",
    "actual_shipping_fee",
    "item_list",
    "pay_time",
    "dropshipper",
    "buyer_message",
    "total_amount",
    "currency",
    "create_time",
    "update_time",
    "order_status",
    "shipping_carrier",
    "payment_method",
    "cancel_reason",
    "cancel_by",
    "buyer_cancel_reason",
  ].join(",");

  return shopGet(path, accessToken, shopId, {
    order_sn_list: orderSnList.join(","),
    response_optional_fields: optionalFields,
  });
}

// =====================================================
// TRẢ HÀNG
// =====================================================

// Lấy danh sách yêu cầu trả hàng.
// pageNo bắt đầu từ 1, pageSize tối đa 100.
async function getReturnList(
  accessToken,
  shopId,
  {
    pageNo = 1,
    pageSize = 50,
    createTimeFrom,
    createTimeTo,
    updateTimeFrom,
    updateTimeTo,
    status,
  } = {},
) {
  const path = "/api/v2/returns/get_return_list";

  const query = {
    page_no: Math.max(Number(pageNo) || 1, 1),
    page_size: Math.min(Math.max(Number(pageSize) || 50, 1), 100),
  };

  if (createTimeFrom != null) {
    query.create_time_from = Number(createTimeFrom);
  }

  if (createTimeTo != null) {
    query.create_time_to = Number(createTimeTo);
  }

  if (updateTimeFrom != null) {
    query.update_time_from = Number(updateTimeFrom);
  }

  if (updateTimeTo != null) {
    query.update_time_to = Number(updateTimeTo);
  }

  if (status) query.status = status;

  return shopGet(path, accessToken, shopId, query);
}

// Lấy chi tiết một yêu cầu trả hàng.
async function getReturnDetail(accessToken, shopId, returnSn) {
  if (!returnSn) {
    throw new Error("Thiếu returnSn");
  }

  const path = "/api/v2/returns/get_return_detail";

  return shopGet(path, accessToken, shopId, {
    return_sn: String(returnSn),
  });
}

// =====================================================
// AUTH
// =====================================================

async function getAccessToken(code, shopId) {
  return publicPost("/api/v2/auth/token/get", {
    code,
    shop_id: Number(shopId),
  });
}

async function refreshAccessToken(refreshToken, shopId) {
  return publicPost("/api/v2/auth/access_token/get", {
    refresh_token: refreshToken,
    shop_id: Number(shopId),
  });
}

module.exports = {
  PARTNER_ID,
  SHOPEE_HOST,

  createSign,
  createShopSign,
  createAuthUrl,

  getAccessToken,
  refreshAccessToken,

  getOrderList,
  getOrderDetail,

  getReturnList,
  getReturnDetail,
};
