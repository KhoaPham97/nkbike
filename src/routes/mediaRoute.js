const express = require("express");
const multer = require("multer");
const { auth, adminOnly } = require("../middlewares/auth");
const mediaController = require("../controllers/mediaController");

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024, files: 20 },
});

router.use(auth, adminOnly);
router.get("/", mediaController.listMedia);
router.post("/upload", upload.array("images", 20), mediaController.uploadMedia);
router.patch("/:id", mediaController.updateMedia);
router.delete("/:id", mediaController.deleteMedia);

module.exports = router;
