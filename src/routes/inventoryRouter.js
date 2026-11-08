const express = require("express");

const router = express.Router();

const { auth } = require("../middlewares/auth");
const adminAuth = require("../middlewares/adminAuth");
const {
  getReservations,
  getReservationDetail,
  getReservationOrderDetail,
} = require("../controllers/inventoryReservationController");

const inventoryController = require("../controllers/inventoryController");

router.post(
  "/",
  auth,
  adminAuth,
  inventoryController.createInventoryReceiptAsync,
);

router.get(
  "/",
  auth,
  adminAuth,
  inventoryController.listInventoryReceiptsAsync,
);

// Phiếu nhập nháp
router.post(
  "/import-drafts",
  auth,
  adminAuth,
  inventoryController.createImportDraftAsync,
);

router.get(
  "/import-drafts",
  auth,
  adminAuth,
  inventoryController.listImportDraftsAsync,
);

router.get(
  "/import-drafts/:id",
  auth,
  adminAuth,
  inventoryController.getImportDraftDetailAsync,
);

router.put(
  "/import-drafts/:id",
  auth,
  adminAuth,
  inventoryController.updateImportDraftAsync,
);

router.delete(
  "/import-drafts/:id",
  auth,
  adminAuth,
  inventoryController.deleteImportDraftAsync,
);

// Nhập kho chính thức
router.post(
  "/batch-import-multiple",
  auth,
  adminAuth,
  inventoryController.createInventoryReceiptAsync,
);

// Danh sách và chi tiết phiếu nhập
router.get("/receipts", inventoryController.listInventoryReceiptsAsync);

router.get("/receipts/:id", inventoryController.getInventoryReceiptDetailAsync);

// Đồng bộ giá vốn
router.post("/sync-zero-costs", inventoryController.syncZeroCost);
// Theo dõi sản phẩm đang được đơn hàng giữ
router.get("/reservations", auth, getReservations);

// Chi tiết giữ hàng của một sản phẩm
router.get("/reservations/:productId", auth, getReservationDetail);
router.get("/reservations/order/:source/:orderId", getReservationOrderDetail);

router.get("/:id", auth, inventoryController.getInventoryReceiptDetailAsync);
module.exports = router;
