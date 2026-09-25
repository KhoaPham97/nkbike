const express = require("express");
const router = express.Router();

const orderController = require("../controllers/orderController");

router.get("/", orderController.listOrdersAsync);
router.get("/:id", orderController.getOrderByIdAsync);
router.post("/", orderController.createOrderAsync);
router.patch("/:id/status", orderController.updateOrderStatusAsync);
router.patch("/sync-product-price", orderController.syncProductPriceAsync);

router.post(
  "/sync-all-uncompleted-prices",
  orderController.syncAllUncompletedOrderPricesAsync,
);
module.exports = router;
