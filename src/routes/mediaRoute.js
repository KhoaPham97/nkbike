const express = require("express");
const multer = require("multer");
const { auth, adminOnly } = require("../middlewares/auth");
const mediaController = require("../controllers/mediaController");

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024, files: 20 },
});

const parseImageUpload = (req, res, next) => {
  upload.array("images", 20)(req, res, (error) => {
    if (!error) return next();
    const status = error.code === "LIMIT_FILE_SIZE" ? 413 : 400;
    return res.status(status).json({
      success: false,
      message:
        error.code === "LIMIT_FILE_SIZE"
          ? "Mỗi ảnh không được vượt quá 12 MB"
          : error.message || "Dữ liệu upload không hợp lệ",
    });
  });
};

router.use(auth, adminOnly);
router.get("/", mediaController.listMedia);
router.post("/upload", parseImageUpload, mediaController.uploadMedia);
router.patch("/:id", mediaController.updateMedia);
router.delete("/:id", mediaController.deleteMedia);

module.exports = router;
