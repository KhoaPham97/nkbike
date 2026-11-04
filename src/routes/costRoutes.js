const express = require("express");
const router = express.Router();
const controller = require("../controllers/costController");
const { auth } = require("../middlewares/auth");

// Gắn middleware xác thực admin hiện tại của dự án trước các route này.
router.get("/", controller.list);
router.get("/history", controller.history);
router.patch("/bulk", controller.updateBulk);
router.patch("/:productId/:variantIndex", controller.updateOne);
router.patch("/:productId/:variantIndex", controller.updateOne);
// Thêm middleware xác thực admin hiện tại của dự án
router.post("/sync", auth, controller.syncUnitCostFromDefaultPrice);
module.exports = router;
