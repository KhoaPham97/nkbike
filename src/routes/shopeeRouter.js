const express = require("express");
const router = express.Router();

const { auth, adminOnly } = require("../middlewares/auth");

const controller = require("../controllers/shopeeController");

// Callback là endpoint Shopee gọi trực tiếp.
// Không được bắt buộc JWT ở đây.
router.get("/callback", controller.shopeeCallback);

// Các endpoint quản trị đều phải xác thực JWT + admin.
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
module.exports = router;
