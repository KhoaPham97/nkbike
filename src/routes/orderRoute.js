const express = require("express");
const router = express.Router();

const orderController = require("../controllers/orderController");
const auth = require("../middlewares/auth");
const adminAuth = require("../middlewares/adminAuth");

// ==================== GET ====================

// Thống kê mua hàng theo khách hàng
// Phải đặt TRƯỚC route /:id
router.get(
  "/customer-purchase-stats",
  orderController.getCustomerPurchaseStatsAsync,
);

// Danh sách đơn hàng
router.get("/", orderController.listOrdersAsync);

// ==================== POST ====================

router.post("/", orderController.createOrderAsync);

router.post(
  "/sync-all-uncompleted-prices",
  orderController.syncAllUncompletedOrderPricesAsync,
);

router.post(
  "/sync-stock",
  auth,
  adminAuth,
  orderController.syncOrderStockAsync,
);

router.post(
  "/rollback-stock",
  auth,
  adminAuth,
  orderController.rollbackOrderStockAsync,
);

router.post("/sync-item-price", orderController.syncProductPriceAsync);

router.post("/sync-variants", orderController.syncOrderVariantsAsync);

router.post("/pay-debt", orderController.payOrderDebtAsync);

router.post("/rebuild-sold-qty", orderController.rebuildProductSoldQtyAsync);

// ==================== PATCH ====================

router.patch("/sync-product-price", orderController.syncProductPriceAsync);

// ==================== PUT ====================

router.put("/:id/status", orderController.updateOrderStatusAsync);

// ==================== GET BY ID ====================

// Route động đặt cuối cùng
router.get("/:id", orderController.getOrderByIdAsync);

module.exports = router;
