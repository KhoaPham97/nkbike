const express = require("express");

const router = express.Router();

const auth = require("../middlewares/auth");
const adminAuth = require("../middlewares/adminAuth");

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

router.get(
  "/:id",
  auth,
  adminAuth,
  inventoryController.getInventoryReceiptDetailAsync,
);

module.exports = router;
