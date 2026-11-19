const axios = require("axios");
const cloudinary = require("cloudinary").v2;
const ShopeeDocument = require("../models/ShopeeDocument");
const ShopeeShop = require("../models/ShopeeShop");
const { callShopeeShopApi } = require("../services/shopeeService");
const clean = (v) => String(v ?? "").trim();
const unwrap = (v) => v?.response || v || {};

const yauzl = require("yauzl");
const XLSX = require("xlsx");
const escapeHtml = (v) => String(v ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;");
function readZipEntries(buffer) {
  return new Promise((resolve,reject) => {
    yauzl.fromBuffer(buffer,{lazyEntries:true,decodeStrings:true},(error,zip) => {
      if(error) return reject(error);
      const entries=[];
      zip.readEntry();
      zip.on("entry",(entry) => {
        const name=String(entry.fileName||"");
        if(/\/$/.test(name)||name.startsWith("__MACOSX/")) return zip.readEntry();
        zip.openReadStream(entry,(streamError,stream) => {
          if(streamError) return reject(streamError);
          const chunks=[]; let size=0;
          stream.on("data",(chunk) => { size+=chunk.length; if(size>30*1024*1024){stream.destroy(new Error("Tệp con trong ZIP vượt quá giới hạn 30 MB."));return;} chunks.push(chunk); });
          stream.on("error",reject);
          stream.on("end",() => { entries.push({name,buffer:Buffer.concat(chunks)}); zip.readEntry(); });
        });
      });
      zip.on("end",() => resolve(entries));
      zip.on("error",reject);
    });
  });
}
function htmlDocument(title,body) {
  return '<!doctype html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>'+escapeHtml(title)+'</title><style>'+
  '*{box-sizing:border-box}body{margin:0;background:#eef2f7;color:#172033;font:14px Arial,sans-serif;padding:20px}h1{font-size:18px;margin:0 0 16px}.pdf-page{position:relative;background:#fff;margin:0 auto 18px;box-shadow:0 2px 12px #17203318;overflow:hidden}.pdf-page span{position:absolute;white-space:pre;transform-origin:left top;color:#111}.sheet{background:#fff;margin:0 0 20px;padding:16px;border:1px solid #dbe3ed;overflow:auto}.sheet h2{font-size:15px;margin:0 0 12px}.sheet table{border-collapse:collapse;width:100%;font-size:12px}.sheet td,.sheet th{border:1px solid #cbd5e1;padding:6px 8px;vertical-align:top;white-space:pre-wrap}.sheet th{background:#eff4fa;font-weight:700}.empty{background:#fff;padding:20px;border-radius:10px;color:#64748b}@media(max-width:700px){body{padding:8px}.sheet{padding:8px}}'+
  '</style></head><body><h1>'+escapeHtml(title)+'</h1>'+body+'</body></html>';
}
async function pdfBufferToHtml(buffer) {
  const pdfjs=await import("pdfjs-dist/legacy/build/pdf.mjs");
  const pdf=await pdfjs.getDocument({data:new Uint8Array(buffer),useSystemFonts:true,disableFontFace:true,isEvalSupported:false}).promise;
  const pages=[]; const textParts=[];
  for(let pageNo=1;pageNo<=pdf.numPages;pageNo+=1){
    const page=await pdf.getPage(pageNo); const viewport=page.getViewport({scale:1.15}); const content=await page.getTextContent();
    const spans=[]; const lines=[];
    for(const item of content.items||[]){
      if(!item.str) continue;
      const transform=item.transform||[]; const x=Number(transform[4]||0)*1.15;
      const y=viewport.height-Number(transform[5]||0)*1.15; const fontSize=Math.max(6,Math.abs(Number(transform[3]||10)*1.15));
      spans.push('<span style="left:'+x.toFixed(1)+'px;top:'+Math.max(0,y-fontSize).toFixed(1)+'px;font-size:'+fontSize.toFixed(1)+'px">'+escapeHtml(item.str)+'</span>');
      lines.push(item.str);
    }
    textParts.push(lines.join(" "));
    pages.push('<section class="pdf-page" style="width:'+viewport.width.toFixed(1)+'px;height:'+viewport.height.toFixed(1)+'px">'+spans.join("")+'</section>');
  }
  return {html:pages.join(""),text:textParts.join("\n\n")};
}
function workbookBufferToHtml(buffer) {
  const workbook=XLSX.read(buffer,{type:"buffer",cellDates:true}); const sections=[]; const textParts=[];
  for(const sheetName of workbook.SheetNames){
    const rows=XLSX.utils.sheet_to_json(workbook.Sheets[sheetName],{header:1,raw:false,defval:""});
    textParts.push("BẢNG: "+sheetName+"\n"+rows.map(row=>row.join("\t")).join("\n"));
    const tableRows=rows.map((row,index)=>'<tr>'+row.map(cell=>'<'+(index===0?"th":"td")+'>'+escapeHtml(cell)+'</'+(index===0?"th":"td")+'>').join("")+'</tr>').join("");
    sections.push('<section class="sheet"><h2>'+escapeHtml(sheetName)+'</h2><table>'+tableRows+'</table></section>');
  }
  return {html:sections.join(""),text:textParts.join("\n\n")};
}
async function buildHtmlPreview(buffer,fileName) {
  const files=[];
  if(buffer.subarray(0,4).toString("hex")==="504b0304") files.push(...await readZipEntries(buffer));
  else files.push({name:clean(fileName||"Shopee document"),buffer});
  const sections=[]; const text=[];
  for(const file of files){
    const ext=String(file.name).toLowerCase().split(".").pop();
    if(ext==="pdf"||file.buffer.subarray(0,4).toString()==="%PDF"){
      const parsed=await pdfBufferToHtml(file.buffer);
      sections.push('<section><h2>'+escapeHtml(file.name)+'</h2>'+parsed.html+'</section>'); text.push(parsed.text);
    }else if(["xlsx","xls"].includes(ext)){
      const parsed=workbookBufferToHtml(file.buffer);
      sections.push('<section><h2>'+escapeHtml(file.name)+'</h2>'+parsed.html+'</section>'); text.push(parsed.text);
    }else if(ext==="csv"||ext==="txt"){
      const raw=file.buffer.toString("utf8"); sections.push('<section class="sheet"><h2>'+escapeHtml(file.name)+'</h2><pre>'+escapeHtml(raw)+'</pre></section>'); text.push(raw);
    }
  }
  if(!sections.length) sections.push('<div class="empty">Đã lưu file gốc nhưng chưa tìm thấy PDF, Excel hoặc CSV có thể chuyển đổi trong gói chứng từ này.</div>');
  return {html:htmlDocument(clean(fileName||"Chứng từ Shopee"),sections.join("")),text:text.join("\n\n")};
}


function getMonthRange(month) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(month || ""))) throw new Error("Tháng phải có định dạng YYYY-MM.");
  const [year, m] = String(month).split("-").map(Number);
  const from = Date.UTC(year, m - 1, 1) / 1000 - 25200;
  const to = Date.UTC(year, m, 1) / 1000 - 25200 - 1;
  return { from, to, periodFrom: new Date(from * 1000), periodTo: new Date(to * 1000) };
}
function configureCloudinary() {
  if (!process.env.CLOUDINARY_URL && process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET) {
    cloudinary.config({ cloud_name: process.env.CLOUDINARY_CLOUD_NAME, api_key: process.env.CLOUDINARY_API_KEY, api_secret: process.env.CLOUDINARY_API_SECRET, secure: true });
  }
  if (!process.env.CLOUDINARY_URL && !(process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET)) throw new Error("Thiếu CLOUDINARY_URL hoặc bộ CLOUDINARY_CLOUD_NAME / CLOUDINARY_API_KEY / CLOUDINARY_API_SECRET để lưu chứng từ.");
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
  if (parsed.protocol !== "https:" || !/(^|\.)shopee\.(vn|com|co|sg|ph|tw|th|my|id)$/.test(parsed.hostname.toLowerCase())) throw new Error("Từ chối tải file từ tên miền không thuộc Shopee.");
  const response = await axios.get(fileLink, { responseType: "arraybuffer", timeout: 90000, maxContentLength: 50 * 1024 * 1024, maxBodyLength: 50 * 1024 * 1024 });
  const buffer = Buffer.from(response.data);
  if (!buffer.length) throw new Error("File chứng từ tải về đang rỗng.");
  const publicId = `shopee_${doc.shopId}_${doc.kind}_${doc.periodKey.replace("-", "_")}.zip`;
  const uploaded = await new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream({
      resource_type: "raw", type: "authenticated", access_mode: "authenticated",
      folder: `nhatkhang/shopee-documents/${doc.shopId}`, public_id: publicId,
      overwrite: true, use_filename: false,
    }, (error, result) => error ? reject(error) : resolve(result));
    stream.end(buffer);
  });
  doc.filePublicId = uploaded.public_id;
  doc.fileName = clean(fileName) || doc.kind + "_" + doc.periodKey + ".zip";
  doc.status = "ready"; doc.downloadedAt = new Date(); doc.error = "";
  try {
    const preview = await buildHtmlPreview(buffer, doc.fileName);
    if (Buffer.byteLength(preview.html, "utf8") > 8 * 1024 * 1024) {
      throw new Error("Bản xem HTML quá lớn để lưu an toàn trong MongoDB.");
    }
    doc.htmlContent = preview.html;
    doc.extractedText = String(preview.text || "").slice(0, 5 * 1024 * 1024);
    doc.htmlGeneratedAt = new Date();
    doc.conversionError = "";
  } catch (conversionError) {
    doc.htmlContent = "";
    doc.extractedText = "";
    doc.conversionError = conversionError.message || "Không chuyển đổi được chứng từ.";
    console.error("[Shopee Documents] HTML conversion failed:", doc.fileName, doc.conversionError);
  }
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
  else if (status === 3) { doc.status = "failed"; doc.error = "Shopee đã đánh dấu báo cáo đã tải nhưng không trả link file."; await doc.save(); }
  else { doc.status = "processing"; await doc.save(); }
  return doc;
}
exports.listDocuments = async (req, res) => {
  try {
    const shopId = clean(req.query.shopId || req.query.shop_id);
    if (!shopId) return res.status(400).json({ success: false, message: "Vui lòng chọn shop Shopee." });
    const query = { shopId }; if (req.query.month) query.periodKey = clean(req.query.month);
    const data = (await ShopeeDocument.find(query).select("-htmlContent -extractedText").sort({ periodKey: -1, kind: 1 }).limit(200).lean()).map((doc) => ({ ...doc, htmlAvailable: Boolean(doc.htmlGeneratedAt && !doc.conversionError) }));
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
    if (doc.filePublicId && doc.htmlContent && ["ready","downloaded"].includes(doc.status)) return res.json({ success: true, data: doc });
    return res.json({ success: true, data: await pollDocument(doc) });
  } catch (e) { return res.status(400).json({ success: false, message: e.message || "Không kiểm tra được trạng thái." }); }
};
exports.downloadDocument = async (req, res) => {
  try {
    const doc = await ShopeeDocument.findOne({ _id: req.params.id, shopId: clean(req.query.shopId) });
    if (!doc) return res.status(404).json({ success: false, message: "Không tìm thấy chứng từ." });
    if (!doc.filePublicId) return res.status(409).json({ success: false, message: "Chứng từ chưa được tải về." });
    configureCloudinary();
    // Authenticated raw files (especially ZIP archives) should use Cloudinary's
    // private download endpoint rather than a delivery URL. The latter can be
    // rejected by Cloudinary's raw-file access checks even when sign_url is set.
    const format = (String(doc.fileName || "").split(".").pop() || "zip").toLowerCase();
    const publicId = String(doc.filePublicId || "").replace(/\\.[a-z0-9]{1,8}$/i, "");
    const url = cloudinary.utils.private_download_url(publicId, format, {
      resource_type: "raw",
      type: "authenticated",
      attachment: true,
      expires_at: Math.floor(Date.now() / 1000) + 60 * 60,
    });
    doc.status = "downloaded"; await doc.save();
    return res.json({ success: true, url, fileName: doc.fileName });
  } catch (e) { return res.status(500).json({ success: false, message: e.message || "Không lấy được link tải." }); }
};

exports.viewDocument = async (req, res) => {
  try {
    let doc = await ShopeeDocument.findOne({
      _id: req.params.id,
      shopId: clean(req.query.shopId || req.query.shop_id),
    });
    if (!doc) return res.status(404).json({ success: false, message: "Không tìm thấy chứng từ." });
    if (!["ready", "downloaded"].includes(doc.status)) return res.status(409).json({ success: false, message: "Chứng từ chưa được tải hoàn tất từ Shopee." });
    // Documents downloaded before HTML preview was introduced are converted lazily
    // by asking Shopee for the completed report link again.
    if (!doc.htmlContent && doc.remoteId) {
      await pollDocument(doc);
      doc = await ShopeeDocument.findById(doc._id);
    }
    if (!doc?.htmlContent) return res.status(422).json({ success: false, message: doc?.conversionError || "Shopee không còn cung cấp file để tạo bản xem HTML. Hãy đồng bộ lại chứng từ của tháng này." });
    return res.json({ success: true, data: {
      kind: doc.kind, periodKey: doc.periodKey, fileName: doc.fileName,
      htmlContent: doc.htmlContent, extractedText: doc.extractedText,
      htmlGeneratedAt: doc.htmlGeneratedAt,
    } });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message || "Không mở được chứng từ." });
  }
};


function parseMoney(value) {
  let s = String(value ?? "").trim().replace(/[₫đ\s]/gi, "");
  if (!s || s === "-" || s === "--") return null;
  if (/^\(.*\)$/.test(s)) s = "-" + s.slice(1, -1);
  s = s.replace(/[^0-9,.-]/g, "");
  if (!s || !/[0-9]/.test(s)) return null;
  if (s.includes(",") && s.includes(".")) s = s.lastIndexOf(",") > s.lastIndexOf(".") ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, "");
  else if (s.includes(",")) s = s.replace(/,/g, "");
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}
function extractRevenueFromText(text, periodKey) {
  const blocks = String(text || "").split(/\n\s*\n/);
  const candidates = [];
  for (const block of blocks) {
    const lines = block.split(/\r?\n/).map(x => x.trim()).filter(Boolean);
    let headerIndex = -1, amountIndex = -1, score = 0;
    for (let i = 0; i < Math.min(lines.length, 30); i += 1) {
      const cells = lines[i].split("\t").map(x => x.trim().toLowerCase());
      const idx = cells.findIndex(x => /(order income|gross sales|sales amount|order amount|buyer paid|doanh thu|tiền hàng|giá trị đơn hàng|tổng tiền hàng)/i.test(x) && !/(refund|hoàn|fee|phí|commission|payout|settlement|đối soát)/i.test(x));
      if (idx >= 0 && cells.length >= 2) { headerIndex = i; amountIndex = idx; score = 10 + cells.length; break; }
    }
    if (headerIndex < 0) continue;
    let total = 0, count = 0;
    for (const line of lines.slice(headerIndex + 1)) {
      const cells = line.split("\t");
      const value = parseMoney(cells[amountIndex]);
      if (value === null) continue;
      const normalized = line.toLowerCase();
      if (/\b(total|subtotal|tổng cộng|tổng doanh thu)\b/.test(normalized)) continue;
      total += value; count += 1;
    }
    if (count) candidates.push({ periodKey, total, count, score });
  }
  return candidates.sort((a,b) => b.score-a.score)[0] || null;
}
exports.getRevenueChart = async (req, res) => {
  try {
    const shopId = clean(req.query.shopId || req.query.shop_id);
    if (!shopId) return res.status(400).json({ success: false, message: "Vui lòng chọn shop Shopee." });
    const [documentCount, detailed] = await Promise.all([
      ShopeeDocument.countDocuments({ shopId, status: { $in: ["ready","downloaded"] } }),
      ShopeeDocument.find({ shopId, kind: "income_report", status: { $in: ["ready","downloaded"] } })
        .select("kind periodKey fileName extractedText conversionError")
        .sort({ periodKey: 1 }).limit(120).lean(),
    ]);
    // The detailed income report is the source of transaction rows. The PDF statement
    // is a monthly summary and is deliberately excluded to avoid double counting.
    const parsed = detailed.map(doc => ({ doc, result: extractRevenueFromText(doc.extractedText, doc.periodKey) }));
    const byMonth = new Map();
    for (const item of parsed) {
      if (!item.result) continue;
      const current = byMonth.get(item.doc.periodKey) || { month: item.doc.periodKey, revenue: 0, transactions: 0, files: 0 };
      current.revenue += item.result.total;
      current.transactions += item.result.count;
      current.files += 1;
      byMonth.set(item.doc.periodKey, current);
    }
    const months = [...byMonth.values()].sort((a,b) => a.month.localeCompare(b.month));
    const totalRevenue = months.reduce((sum, item) => sum + item.revenue, 0);
    return res.json({ success: true, data: {
      totalRevenue, months, documents: documentCount, detailedFiles: detailed.length,
      parsedFiles: parsed.filter(x => x.result).length,
      unparsedFiles: parsed.filter(x => !x.result).map(x => ({ periodKey: x.doc.periodKey, fileName: x.doc.fileName, reason: x.doc.conversionError || "Không tìm thấy cột doanh thu phù hợp trong dữ liệu đã trích xuất." })),
      source: "income_report",
    }});
  } catch (error) {
    console.error("[Shopee Documents] Revenue chart failed:", error);
    return res.status(500).json({ success: false, message: error.message || "Không tổng hợp được doanh thu từ chứng từ." });
  }
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
  const shops = await ShopeeShop.find({ status: "connected" }).select("shopId").lean();
  for (const shop of shops) {
    for (const kind of ["income_statement","income_report"]) {
      try { await createOrReuse(String(shop.shopId), kind, month, range, "system-cron"); }
      catch (e) { console.error("[Shopee Documents] monthly create failed", shop.shopId, kind, e.message); }
    }
  }
};
