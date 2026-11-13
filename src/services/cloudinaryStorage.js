const cloudinary = require("cloudinary").v2;

let configured = false;
const ensureConfigured = () => {
  if (configured) return;
  const missing = ["CLOUDINARY_CLOUD_NAME", "CLOUDINARY_API_KEY", "CLOUDINARY_API_SECRET"].filter((key) => !process.env[key]);
  if (missing.length) { const error = new Error("Thiếu cấu hình Cloudinary: " + missing.join(", ")); error.statusCode = 503; throw error; }
  cloudinary.config({ cloud_name: process.env.CLOUDINARY_CLOUD_NAME, api_key: process.env.CLOUDINARY_API_KEY, api_secret: process.env.CLOUDINARY_API_SECRET, secure: true });
  configured = true;
};

const uploadImage = (file, folder, publicId) => new Promise((resolve, reject) => {
  try { ensureConfigured();
    const stream = cloudinary.uploader.upload_stream({ folder: "nhat-khang-bike/" + folder, public_id: publicId, resource_type: "image", overwrite: false, unique_filename: false, use_filename: false }, (error, result) => {
      if (error) { console.error("[Cloudinary] upload failed:", error.message); const e = new Error("Không thể tải ảnh lên Cloudinary: " + error.message); e.statusCode = 502; return reject(e); }
      resolve({ url: result.secure_url, key: result.public_id, bytes: result.bytes });
    }); stream.end(file.buffer);
  } catch (error) { reject(error); }
});

const deleteImage = async (publicId) => {
  ensureConfigured();
  const result = await cloudinary.uploader.destroy(publicId, { resource_type: "image", invalidate: true });
  if (result.result !== "ok" && result.result !== "not found") { const error = new Error("Không thể xóa ảnh khỏi Cloudinary"); error.statusCode = 502; throw error; }
  return true;
};

module.exports = { uploadImage, deleteImage };