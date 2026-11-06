const express = require("express");
const router = express.Router();

const { auth, adminOnly } = require("../middlewares/auth");

const shopeeController = require("../controllers/shopeeController");
const shopeeOrderController = require("../controllers/shopeeOrderController");
const shopeeStockController = require("../controllers/shopeeStockController");
const shopeeAutoStockController = require("../controllers/shopeeAutoStockController");
const adminAuth = [auth, adminOnly];

// =====================================================
// AUTHENTICATION & SHOP MANAGEMENT
// =====================================================

router.post("/auth", ...adminAuth, shopeeController.connectShopee);

router.get("/callback", shopeeController.shopeeCallback);

router.get("/shops", ...adminAuth, shopeeController.getShopeeShops);

router.post(
  "/refresh-token",
  ...adminAuth,
  shopeeController.refreshShopeeToken,
);

router.delete(
  "/shops/:shopId",
  ...adminAuth,
  shopeeController.disconnectShopeeShop,
);

// =====================================================
// ORDER SYNC
// =====================================================

router.post(
  "/orders/sync",
  ...adminAuth,
  shopeeOrderController.syncOrdersAsync,
);

router.get("/orders", ...adminAuth, shopeeOrderController.getOrdersAsync);

router.get(
  "/orders/:orderSn",
  ...adminAuth,
  shopeeOrderController.getOrderDetailAsync,
);

router.get(
  "/sync/status",
  ...adminAuth,
  shopeeOrderController.getSyncStatusAsync,
);

// =====================================================
// SKU MAPPING
// =====================================================

router.get(
  "/management/sku-mappings",
  ...adminAuth,
  shopeeController.getSkuMappingsAsync,
);

router.post(
  "/management/sku-mappings",
  ...adminAuth,
  shopeeController.createSkuMappingAsync,
);

router.put(
  "/management/sku-mappings/:id",
  ...adminAuth,
  shopeeController.updateSkuMappingAsync,
);

router.delete(
  "/management/sku-mappings/:id",
  ...adminAuth,
  shopeeController.deleteSkuMappingAsync,
);

router.post(
  "/management/sku-mappings/auto-match",
  ...adminAuth,
  shopeeController.autoMatchSkuMappingsAsync,
);

// =====================================================
// STOCK MANAGEMENT
// =====================================================

// Tổng quan tồn kho Shopee
router.get(
  "/stock/summary",
  ...adminAuth,
  shopeeStockController.getStockSummaryAsync,
);

// Danh sách giao dịch tồn kho
router.get(
  "/stock/transactions",
  ...adminAuth,
  shopeeStockController.getStockTransactionsAsync,
);

// Danh sách đơn cần xử lý kho
router.get(
  "/stock/pending-orders",
  ...adminAuth,
  shopeeStockController.getPendingStockOrdersAsync,
);

// Chi tiết trạng thái kho của đơn
router.get(
  "/stock/orders/:orderSn",
  ...adminAuth,
  shopeeStockController.getOrderStockDetailAsync,
);

// Giữ tồn kho cho đơn
router.post(
  "/stock/orders/:orderSn/reserve",
  ...adminAuth,
  shopeeStockController.reserveOrderStockAsync,
);

// Xác nhận trừ kho FIFO
router.post(
  "/stock/orders/:orderSn/deduct",
  ...adminAuth,
  shopeeStockController.deductOrderStockAsync,
);

// Giải phóng tồn kho khi đơn bị hủy
router.post(
  "/stock/orders/:orderSn/release",
  ...adminAuth,
  shopeeStockController.releaseOrderStockAsync,
);

// =====================================================
// ORDER STOCK OPERATIONS
// =====================================================

// Xem trước phân bổ FIFO
router.post(
  "/orders/:orderSn/stock/preview",
  ...adminAuth,
  shopeeStockController.previewStockDeductionAsync,
);

// Xuất kho theo đơn
router.post(
  "/orders/:orderSn/stock/deduct",
  ...adminAuth,
  shopeeStockController.deductStockAsync,
);

// Lịch sử giao dịch kho theo đơn
router.get(
  "/orders/:orderSn/stock/history",
  ...adminAuth,
  shopeeStockController.getStockHistoryAsync,
);

// Tiếp nhận hàng hoàn
router.post(
  "/orders/:orderSn/returns/receive",
  ...adminAuth,
  shopeeStockController.receiveReturnAsync,
);

// =====================================================
// AUTO STOCK MANAGEMENT
// =====================================================

router.get(
  "/auto-stock/orders",
  ...adminAuth,
  shopeeAutoStockController.getAutoStockOrdersAsync,
);

router.get(
  "/auto-stock/history",
  ...adminAuth,
  shopeeAutoStockController.getAutoStockHistoryAsync,
);

router.get(
  "/auto-stock/settings",
  ...adminAuth,
  shopeeAutoStockController.getAutoStockSettingsAsync,
);

router.put(
  "/auto-stock/settings",
  ...adminAuth,
  shopeeAutoStockController.updateAutoStockSettingsAsync,
);

router.post(
  "/auto-stock/run",
  ...adminAuth,
  shopeeAutoStockController.runAutoStockNowAsync,
);

router.post(
  "/auto-stock/process-selected",
  ...adminAuth,
  shopeeAutoStockController.processSelectedOrdersAsync,
);
module.exports = router;
