const express = require("express");
const router = express.Router();

const { auth, adminOnly } = require("../middlewares/auth");

const skuController = require("../controllers/skuController");

// Tất cả API đều yêu cầu đăng nhập Admin
router.get("/", auth, adminOnly, skuController.getSkuManagement);

router.get("/export.csv", auth, adminOnly, skuController.exportSkuManagement);

module.exports = router;
