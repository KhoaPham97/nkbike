const crypto = require("crypto");
const axios = require("axios");

const PARTNER_ID = Number(process.env.SHOPEE_PARTNER_ID);
const PARTNER_KEY = process.env.SHOPEE_PARTNER_KEY;

const IS_SANDBOX = process.env.SHOPEE_ENV === "sandbox";

const SHOPEE_HOST = IS_SANDBOX
  ? "https://partner.test-stable.shopeemobile.com"
  : "https://partner.shopeemobile.com";

console.log("========== SHOPEE CONFIG ==========");
console.log("Environment:", IS_SANDBOX ? "sandbox" : "live");
console.log("Partner ID:", PARTNER_ID);
console.log("Partner Key exists:", !!PARTNER_KEY);
console.log("API Host:", SHOPEE_HOST);
console.log("===================================");

function validateConfig() {
  if (!Number.isSafeInteger(PARTNER_ID) || PARTNER_ID <= 0 || !PARTNER_KEY) {
    throw new Error("Shopee Partner configuration is invalid");
  }
}

// Chữ ký Public API
function createSign(path, timestamp) {
  validateConfig();

  const baseString = `${PARTNER_ID}${path}${timestamp}`;

  return crypto
    .createHmac("sha256", PARTNER_KEY)
    .update(baseString)
    .digest("hex");
}

// Chữ ký Shop API
function createShopSign(path, timestamp, accessToken, shopId) {
  validateConfig();

  const baseString = `${PARTNER_ID}${path}${timestamp}${accessToken}${shopId}`;

  return crypto
    .createHmac("sha256", PARTNER_KEY)
    .update(baseString)
    .digest("hex");
}

// Tạo link OAuth
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

// Public API
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
      timeout: 20000,
    },
  );

  if (response.data?.error) {
    throw new Error(
      `${response.data.error}: ${
        response.data.message || response.data.msg || ""
      }`,
    );
  }

  return response.data;
}

// Shop API GET
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

  if (response.data?.error) {
    throw new Error(
      `${response.data.error}: ${
        response.data.message ||
        response.data.msg ||
        response.data.debug_message ||
        ""
      }`,
    );
  }

  return response.data;
}

// Lấy danh sách mã đơn
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

  if (orderStatus) {
    query.order_status = orderStatus;
  }

  return shopGet(path, accessToken, shopId, query);
}

// Lấy chi tiết đơn hàng
async function getOrderDetail(accessToken, shopId, orderSnList) {
  if (!Array.isArray(orderSnList) || orderSnList.length === 0) {
    return { response: { order_list: [] } };
  }

  if (orderSnList.length > 50) {
    throw new Error("Mỗi lần chỉ lấy tối đa 50 đơn hàng");
  }

  const path = "/api/v2/order/get_order_detail";

  return shopGet(path, accessToken, shopId, {
    order_sn_list: orderSnList.join(","),
    response_optional_fields: [
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
    ].join(","),
  });
}

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
};
