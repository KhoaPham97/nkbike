const express = require("express");

const router = express.Router();

const { auth, adminOnly } = require("../middlewares/auth");

const controller = require("../controllers/shopeeManagementController");

router.use(auth, adminOnly);

// SKU mapping
router.get("/sku-mappings", controller.getSkuMappings);
router.post("/sku-mappings", controller.saveSkuMapping);
router.patch("/sku-mappings/:id/disable", controller.disableSkuMapping);

// Đơn hàng đã lưu
router.get("/orders", controller.getSavedOrders);
router.get("/orders/:orderSn", controller.getSavedOrderDetail);

// Trả hàng đã lưu
router.get("/returns", controller.getSavedReturns);
router.get("/returns/:returnSn", controller.getSavedReturnDetail);

module.exports = router;
