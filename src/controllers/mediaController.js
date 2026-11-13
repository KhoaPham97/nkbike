const crypto = require("crypto");
const path = require("path");
const { Media } = require("../models/media");
const { Product } = require("../models/products");
const { putObject, deleteObject } = require("../services/r2Storage");

const MIME_EXTENSIONS = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
};

const isValidImage = (buffer, mimeType) => {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return false;
  if (mimeType === "image/jpeg") return buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255;
  if (mimeType === "image/png") return buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (mimeType === "image/webp") return buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP";
  if (mimeType === "image/gif") {
    const signature = buffer.toString("ascii", 0, 6);
    return signature === "GIF87a" || signature === "GIF89a";
  }
  return false;
};

const safeName = (name) =>
  path.basename(String(name || "image"))
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100) || "image";

const listMedia = async (req, res) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 40));
    const q = String(req.query.q || "").trim();
    const folder = String(req.query.folder || "").trim();
    const filter = {};
    if (q) {
      const escaped = q.replace(/[.*+?^\${}()|[\]\\]/g, "\\$&");
      filter.$or = [
        { filename: { $regex: escaped, $options: "i" } },
        { originalName: { $regex: escaped, $options: "i" } },
        { alt: { $regex: escaped, $options: "i" } },
      ];
    }
    if (folder) filter.folder = folder;

    const [media, total, stats] = await Promise.all([
      Media.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      Media.countDocuments(filter),
      Media.aggregate([{ $group: { _id: null, totalSize: { $sum: "$size" }, count: { $sum: 1 } } }]),
    ]);
    return res.json({
      success: true,
      media,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit), hasMore: page * limit < total },
      stats: { count: stats[0]?.count || 0, totalSize: stats[0]?.totalSize || 0 },
    });
  } catch (error) {
    console.error("listMedia:", error);
    return res.status(500).json({ success: false, message: "Không thể tải thư viện ảnh" });
  }
};

const uploadMedia = async (req, res) => {
  const files = req.files || [];
  if (!files.length) return res.status(400).json({ success: false, message: "Vui lòng chọn ít nhất một ảnh" });

  const uploaded = [];
  try {
    const folder = safeName(req.body.folder || "products").replace(/\./g, "-");
    for (const file of files) {
      if (!MIME_EXTENSIONS[file.mimetype] || !isValidImage(file.buffer, file.mimetype)) {
        const error = new Error("File " + file.originalname + " không phải ảnh hợp lệ (JPG, PNG, WEBP, GIF)");
        error.statusCode = 400;
        throw error;
      }
      const filename = crypto.randomUUID() + "." + MIME_EXTENSIONS[file.mimetype];
      const storageKey = folder + "/" + filename;
      const stored = await putObject({ key: storageKey, body: file.buffer, contentType: file.mimetype });
      try {
        const record = await Media.create({
          filename,
          originalName: safeName(file.originalname),
          url: stored.url,
          storageKey,
          mimeType: file.mimetype,
          size: file.size,
          folder,
          uploadedBy: req.user?._id || null,
        });
        uploaded.push(record);
      } catch (dbError) {
        await deleteObject(storageKey).catch(() => {});
        throw dbError;
      }
    }
    return res.status(201).json({ success: true, message: "Đã tải lên " + uploaded.length + " ảnh", media: uploaded });
  } catch (error) {
    console.error("uploadMedia:", error);
    return res.status(error.statusCode || 500).json({
      success: false,
      message: error.message || "Không thể tải ảnh lên",
      uploaded,
    });
  }
};

const updateMedia = async (req, res) => {
  try {
    const updates = {};
    if (typeof req.body.alt === "string") updates.alt = req.body.alt.trim().slice(0, 300);
    if (typeof req.body.folder === "string") updates.folder = safeName(req.body.folder).replace(/\./g, "-");
    const media = await Media.findByIdAndUpdate(req.params.id, updates, { new: true, runValidators: true });
    if (!media) return res.status(404).json({ success: false, message: "Không tìm thấy ảnh" });
    return res.json({ success: true, media });
  } catch (error) {
    console.error("updateMedia:", error);
    return res.status(500).json({ success: false, message: "Không thể cập nhật ảnh" });
  }
};

const deleteMedia = async (req, res) => {
  try {
    const media = await Media.findById(req.params.id);
    if (!media) return res.status(404).json({ success: false, message: "Không tìm thấy ảnh" });
    const references = await Product.findOne({
      $or: [
        { thumbnail: media.url },
        { images: media.url },
        { "variants.thumbnail": media.url },
        { "variants.image": media.url },
      ],
    }).select("_id title").lean();

    if (references) {
      return res.status(409).json({
        success: false,
        inUse: true,
        message: 'Ảnh đang được sử dụng bởi sản phẩm "' + (references.title || references._id) + '". Hãy gỡ ảnh khỏi sản phẩm trước khi xóa.',
        product: references,
      });
    }
    await deleteObject(media.storageKey);
    await media.deleteOne();
    return res.json({ success: true, message: "Đã xóa ảnh" });
  } catch (error) {
    console.error("deleteMedia:", error);
    return res.status(error.statusCode || 500).json({ success: false, message: error.message || "Không thể xóa ảnh" });
  }
};

module.exports = { listMedia, uploadMedia, updateMedia, deleteMedia };
