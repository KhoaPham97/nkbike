const express = require("express");
const router = express.Router();

const orderController = require("../controllers/orderController");
const auth = require("../middlewares/auth");
const adminAuth = require("../middlewares/adminAuth");
router.get("/", orderController.listOrdersAsync);
router.get("/:id", orderController.getOrderByIdAsync);
router.post("/", orderController.createOrderAsync);
router.put("/:id/status", orderController.updateOrderStatusAsync);
router.patch("/sync-product-price", orderController.syncProductPriceAsync);

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
module.exports = router;
