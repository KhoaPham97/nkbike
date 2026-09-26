const express = require("express");

const router = express.Router();

const { changeAdminPasswordAsync } = require("../controllers/adminController");

const auth = require("../middlewares/auth");
const adminAuth = require("../middlewares/adminAuth");

// ============================================================
// CHANGE ADMIN PASSWORD
// ============================================================

router.put("/change-password", auth, adminAuth, changeAdminPasswordAsync);

module.exports = router;
