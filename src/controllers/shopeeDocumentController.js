const axios = require("axios");
const cloudinary = require("cloudinary").v2;
const ShopeeDocument = require("../models/ShopeeDocument");
const ShopeeShop = require("../models/ShopeeShop");
const { callShopeeShopApi } = require("../services/shopeeService");
const clean = (v) => String(v ?? "").trim();
const unwrap = (v) => v?.response || v || {};

function getMonthRange(month) {
  if (!/^\\d{4}-(0[1-9]|1[0-2])$/.test(String(month || ""))) throw new Error("Tháng phải có định dạng YYYY-MM.");
  const [year, m] = String(month).split("-").map(Number);
  const from = Date.UTC(year, m - 1, 1) / 1000 - 25200;
  const to = Date.UTC(year, m, 1) / 1000 - 25200 - 1;
  return { from, to, periodFrom: new Date(from * 1000), periodTo: new Date(to * 1000) };
}
function configureCloudinary() {
  if (!process.env.CLOUDINARY_URL && process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET) {
    cloudinary.config({ cloud_name: process.env.CLOUDINARY_CLOUD_NAME, api_key: process.env.CLOUDINARY_API_KEY, api_secret: process.env.CLOUDINARY_API_SECRET, secure: true });
  }
  if (!process.env.CLOUDINARY_URL && !process.env.CLOUDINARY_CLOUD_NAME) throw new Error("Thiếu cấu hình Cloudinary để lưu file chứng từ.");
}
async function createRemote(shopId, kind, range) {
  const statement = kind === "income_statement";
  const path = statement ? "/api/v2/payment/generate_income_statement" : "/api/v2/payment/generate_income_report";
  const params = { release_time_from: range.from, release_time_to: range.to, ...(statement ? { statement_type: 2 } : {}) };
  const raw = await callShopeeShopApi({ shopId, path, method: "GET", params });
  const data = unwrap(raw);
  const id = data.id || data.income_statement_id || data.income_report_id;
  if (!id) throw new Error("Shopee không trả về mã yêu cầu báo cáo.");
  return { id: String(id), requestId: raw.request_id || "" };
}
async function createOrReuse(shopId, kind, month, range, createdBy) {
  let doc = await ShopeeDocument.findOne({ shopId, kind, periodKey: month });
  if (doc && ["ready","downloaded","requested","processing"].includes(doc.status)) return doc;
  const remote = await createRemote(shopId, kind, range);
  if (!doc) doc = new ShopeeDocument({ shopId, kind, periodKey: month, periodFrom: range.periodFrom, periodTo: range.periodTo });
  Object.assign(doc, { remoteId: remote.id, requestId: remote.requestId, status: "requested", remoteStatus: null, error: "", filePublicId: "", fileName: "", createdBy: String(createdBy || "") });
  await doc.save();
  return doc;
}
async function storeRemoteFile(doc, fileLink, fileName) {
  configureCloudinary();
  let parsed;
  try { parsed = new URL(fileLink); } catch { throw new Error("Shopee trả về link file không hợp lệ."); }
  if (parsed.protocol !== "https:" || !/(^|\\.)shopee\\.(vn|com|co|sg|ph|tw|th|my|id)$/.test(parsed.hostname.toLowerCase())) throw new Error("Từ chối tải file từ tên miền không thuộc Shopee.");
  const response = await axios.get(fileLink, { responseType: "arraybuffer", timeout: 90000, maxContentLength: 50 * 1024 * 1024, maxBodyLength: 50 * 1024 * 1024 });
  const buffer = Buffer.from(response.data);
  if (!buffer.length) throw new Error("File chứng từ tải về đang rỗng.");
  const publicId = `shopee_${doc.shopId}_${doc.kind}_${doc.periodKey.replace("-", "_")}`;
  await new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream({
      resource_type: "raw", type: "authenticated", access_mode: "authenticated",
      folder: `nhatkhang/shopee-documents/${doc.shopId}`, public_id: publicId,
      overwrite: true, use_filename: false,
    }, (error, result) => error ? reject(error) : resolve(result));
    stream.end(buffer);
  });
  doc.filePublicId = `nhatkhang/shopee-documents/${doc.shopId}/${publicId}`;
  doc.fileName = clean(fileName) || `${doc.kind}_${doc.periodKey}.zip`;
  doc.status = "ready"; doc.downloadedAt = new Date(); doc.error = "";
  await doc.save();
}
async function pollDocument(doc) {
  const statement = doc.kind === "income_statement";
  const path = statement ? "/api/v2/payment/get_income_statement" : "/api/v2/payment/get_income_report";
  const params = statement ? { income_statement_id: Number(doc.remoteId) } : { income_report_id: Number(doc.remoteId) };
  const raw = await callShopeeShopApi({ shopId: doc.shopId, path, method: "GET", params });
  const data = unwrap(raw); const status = Number(data.status);
  doc.remoteStatus = Number.isFinite(status) ? status : null;
  doc.requestId = raw.request_id || doc.requestId; doc.lastCheckedAt = new Date();
  if ((status === 2 || status === 3) && data.file_link) await storeRemoteFile(doc, data.file_link, data.file_name);
  else if (status === 1) { doc.status = "processing"; await doc.save(); }
  else if (status === 4 || status === 0 || data.error) { doc.status = "failed"; doc.error = data.message || data.error || `Shopee báo trạng thái ${status}`; await doc.save(); }
  else { doc.status = "processing"; await doc.save(); }
  return doc;
}
exports.listDocuments = async (req, res) => {
  try {
    const shopId = clean(req.query.shopId || req.query.shop_id);
    if (!shopId) return res.status(400).json({ success: false, message: "Vui lòng chọn shop Shopee." });
    const query = { shopId }; if (req.query.month) query.periodKey = clean(req.query.month);
    const data = await ShopeeDocument.find(query).sort({ periodKey: -1, kind: 1 }).limit(200).lean();
    return res.json({ success: true, data });
  } catch (e) { return res.status(500).json({ success: false, message: e.message || "Không tải được chứng từ." }); }
};
exports.syncMonth = async (req, res) => {
  try {
    const shopId = clean(req.body.shopId || req.body.shop_id); const month = clean(req.body.month);
    if (!shopId) return res.status(400).json({ success: false, message: "Vui lòng chọn shop Shopee." });
    const range = getMonthRange(month); const data = [];
    for (const kind of ["income_statement","income_report"]) {
      try { const doc = await createOrReuse(shopId, kind, month, range, req.user?._id || req.user?.id); data.push({ id: doc._id, kind, status: doc.status, remoteId: doc.remoteId }); }
      catch (e) { data.push({ kind, status: "failed", error: e.message }); }
    }
    const success = data.some((x) => x.status !== "failed");
    return res.status(success ? 202 : 400).json({ success, message: success ? "Đã gửi yêu cầu tạo báo cáo Shopee." : "Không tạo được báo cáo. Kiểm tra quyền Finance/Payment của ứng dụng Shopee.", data });
  } catch (e) { return res.status(400).json({ success: false, message: e.message || "Không thể tạo báo cáo." }); }
};
exports.pollOne = async (req, res) => {
  try {
    const doc = await ShopeeDocument.findOne({ _id: req.params.id, shopId: clean(req.body.shopId || req.query.shopId) });
    if (!doc) return res.status(404).json({ success: false, message: "Không tìm thấy chứng từ." });
    if (doc.filePublicId && ["ready","downloaded"].includes(doc.status)) return res.json({ success: true, data: doc });
    return res.json({ success: true, data: await pollDocument(doc) });
  } catch (e) { return res.status(400).json({ success: false, message: e.message || "Không kiểm tra được trạng thái." }); }
};
exports.downloadDocument = async (req, res) => {
  try {
    const doc = await ShopeeDocument.findOne({ _id: req.params.id, shopId: clean(req.query.shopId) });
    if (!doc) return res.status(404).json({ success: false, message: "Không tìm thấy chứng từ." });
    if (!doc.filePublicId) return res.status(409).json({ success: false, message: "Chứng từ chưa được tải về." });
    configureCloudinary();
    const url = cloudinary.url(doc.filePublicId, { resource_type: "raw", type: "authenticated", sign_url: true, secure: true, attachment: true });
    doc.status = "downloaded"; await doc.save();
    return res.json({ success: true, url, fileName: doc.fileName });
  } catch (e) { return res.status(500).json({ success: false, message: e.message || "Không lấy được link tải." }); }
};
exports.pollPendingDocuments = async () => {
  const docs = await ShopeeDocument.find({ status: { $in: ["requested","processing"] } }).limit(30);
  for (const doc of docs) { try { await pollDocument(doc); } catch (e) { doc.lastCheckedAt = new Date(); doc.error = e.message || String(e); await doc.save(); console.error("[Shopee Documents] poll failed", doc.shopId, doc.error); } }
};
exports.createPreviousMonthForAllShops = async () => {
  const now = new Date(); const vnNow = new Date(now.getTime() + 7 * 3600000);
  const monthDate = new Date(Date.UTC(vnNow.getUTCFullYear(), vnNow.getUTCMonth() - 1, 1));
  const month = `${monthDate.getUTCFullYear()}-${String(monthDate.getUTCMonth() + 1).padStart(2,"0")}`;
  const range = getMonthRange(month);
  const shops = await ShopeeShop.find({ status: { $ne: "disconnected" } }).select("shopId").lean();
  for (const shop of shops) {
    for (const kind of ["income_statement","income_report"]) {
      try { await createOrReuse(String(shop.shopId), kind, month, range, "system-cron"); }
      catch (e) { console.error("[Shopee Documents] monthly create failed", shop.shopId, kind, e.message); }
    }
  }
};
