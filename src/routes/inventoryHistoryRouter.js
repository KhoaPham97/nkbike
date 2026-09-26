const express = require("express");

const router = express.Router();

const auth = require("../middlewares/auth");
const adminAuth = require("../middlewares/adminAuth");
const {
  listInventoryHistoryAsync,
} = require("../controllers/inventoryHistoryController");
const {
  rebuildInventoryHistoryAsync,
} = require("../controllers/inventoryHistoryController");
router.get("/", auth, adminAuth, listInventoryHistoryAsync);

router.post("/rebuild", auth, adminAuth, rebuildInventoryHistoryAsync);

module.exports = router;
