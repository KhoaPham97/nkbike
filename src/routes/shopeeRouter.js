const express = require("express");
const router = express.Router();

const { auth, adminOnly } = require("../middlewares/auth");

const controller = require("../controllers/shopeeController");
const shopeeInventoryController = require("../controllers/shopeeInventoryController");
const shopeeProductController = require("../controllers/shopeeProductController");

// =====================================================
// SHOPEE CALLBACK
// Shopee gọi trực tiếp, không yêu cầu JWT
// =====================================================

router.get("/callback", controller.shopeeCallback);

// =====================================================
// QUẢN LÝ SHOP VÀ ĐƠN HÀNG
// =====================================================

router.post("/auth", auth, adminOnly, controller.connectShopee);

router.get("/shops", auth, adminOnly, controller.getShopeeShops);

router.post("/refresh-token", auth, adminOnly, controller.refreshShopeeToken);

router.delete(
  "/shops/:shopId",
  auth,
  adminOnly,
  controller.disconnectShopeeShop,
);

router.post("/orders/sync", auth, adminOnly, controller.viewShopeeOrders);

// =====================================================
// QUẢN LÝ KHO SHOPEE
// =====================================================

// Xác nhận xuất kho một sản phẩm trong đơn
router.post(
  "/inventory/orders/:orderSn/export",
  auth,
  adminOnly,
  shopeeInventoryController.exportOrderItem,
);

// Nhận và kiểm tra hàng hoàn
router.post(
  "/inventory/returns/:returnSn/receive",
  auth,
  adminOnly,
  shopeeInventoryController.receiveReturnItem,
);

// Lịch sử giao dịch kho Shopee
router.get(
  "/inventory/transactions",
  auth,
  adminOnly,
  shopeeInventoryController.getTransactions,
);
// QUẢN LÝ SẢN PHẨM SHOPEE
// =====================================================

router.post(
  "/products/sync",
  auth,
  adminOnly,
  shopeeProductController.syncProducts,
);

router.get("/products", auth, adminOnly, shopeeProductController.getProducts);
module.exports = router;
