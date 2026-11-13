const cloudinary = require("cloudinary").v2;

// Dùng chung tên biến môi trường với media library.
// CLOUDINARY_NAME được giữ làm fallback để không làm hỏng cấu hình cũ.
const cloudName =
  process.env.CLOUDINARY_CLOUD_NAME || process.env.CLOUDINARY_NAME;

if (cloudName && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET) {
  cloudinary.config({
    cloud_name: cloudName,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
    secure: true,
  });
}

module.exports = cloudinary;
