const crypto = require("crypto");

const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");
const hmac = (key, value, encoding) => crypto.createHmac("sha256", key).update(value).digest(encoding);

const encodePath = (value) =>
  String(value).split("/").map((part) =>
    encodeURIComponent(part).replace(/[!'()*]/g, (char) =>
      "%" + char.charCodeAt(0).toString(16).toUpperCase(),
    ),
  ).join("/");

const getConfig = () => {
  const config = {
    accountId: process.env.R2_ACCOUNT_ID,
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    bucket: process.env.R2_BUCKET_NAME,
    publicUrl: String(process.env.R2_PUBLIC_URL || "").replace(/\/+$/, ""),
  };
  const missing = Object.entries(config)
    .filter(([key, value]) => key !== "publicUrl" && !value)
    .map(([key]) => key);
  if (missing.length || !config.publicUrl) {
    const fields = [...missing, ...(!config.publicUrl ? ["R2_PUBLIC_URL"] : [])];
    const error = new Error("Thiếu cấu hình Cloudflare R2: " + fields.join(", "));
    error.statusCode = 503;
    throw error;
  }
  return config;
};

const signRequest = ({ method, key, body, contentType }) => {
  const config = getConfig();
  const host = config.accountId + ".r2.cloudflarestorage.com";
  const canonicalUri = "/" + encodeURIComponent(config.bucket) + "/" + encodePath(key);
  const payloadHash = hash(body || Buffer.alloc(0));
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const headers = {
    host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  };
  if (contentType) headers["content-type"] = contentType;

  const signedHeaders = Object.keys(headers).sort().join(";");
  const canonicalHeaders = Object.keys(headers).sort()
    .map((name) => name + ":" + String(headers[name]).trim() + "\n").join("");
  const canonicalRequest = [method, canonicalUri, "", canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const scope = dateStamp + "/auto/s3/aws4_request";
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, hash(canonicalRequest)].join("\n");
  const dateKey = hmac("AWS4" + config.secretAccessKey, dateStamp);
  const regionKey = hmac(dateKey, "auto");
  const serviceKey = hmac(regionKey, "s3");
  const signingKey = hmac(serviceKey, "aws4_request");
  const signature = hmac(signingKey, stringToSign, "hex");
  headers.Authorization =
    "AWS4-HMAC-SHA256 Credential=" + config.accessKeyId + "/" + scope +
    ", SignedHeaders=" + signedHeaders + ", Signature=" + signature;

  return { url: "https://" + host + canonicalUri, headers, config };
};

const putObject = async ({ key, body, contentType }) => {
  const signed = signRequest({ method: "PUT", key, body, contentType });
  const response = await fetch(signed.url, { method: "PUT", headers: signed.headers, body });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    console.error("[R2] PUT failed:", response.status, detail.slice(0, 500));
    const error = new Error("Không thể tải ảnh lên Cloudflare R2 (" + response.status + ")");
    error.statusCode = 502;
    throw error;
  }
  return { url: signed.config.publicUrl + "/" + encodePath(key), key };
};

const deleteObject = async (key) => {
  const signed = signRequest({ method: "DELETE", key, body: Buffer.alloc(0) });
  const response = await fetch(signed.url, { method: "DELETE", headers: signed.headers });
  if (!response.ok && response.status !== 404) {
    const detail = await response.text().catch(() => "");
    console.error("[R2] DELETE failed:", response.status, detail.slice(0, 500));
    const error = new Error("Không thể xóa ảnh khỏi Cloudflare R2 (" + response.status + ")");
    error.statusCode = 502;
    throw error;
  }
  return true;
};

module.exports = { putObject, deleteObject };
