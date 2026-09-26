const express = require("express");

const router = express.Router();

const auth = require("../middlewares/auth");
const adminAuth = require("../middlewares/adminAuth");
const {
  listInventoryHistoryAsync,
} = require("../controllers/inventoryHistoryController");

router.get("/", auth, adminAuth, listInventoryHistoryAsync);

module.exports = router;
