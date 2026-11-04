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

function createSign(path, timestamp) {
  validateConfig();

  const baseString = `${PARTNER_ID}${path}${timestamp}`;

  return crypto
    .createHmac("sha256", PARTNER_KEY)
    .update(baseString)
    .digest("hex");
}

// Tạo link OAuth Shopee Open API v2
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
  createAuthUrl,
  getAccessToken,
  refreshAccessToken,
};
