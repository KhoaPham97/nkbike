const express = require("express");

const router = express.Router();

const {
  getSettingsAsync,
  updateSettingsAsync,
  resetSettingsAsync,
} = require("../controllers/settingsController");

// ============================================================
// GET CONFIG
// ============================================================

router.get("/", getSettingsAsync);

// ============================================================
// UPDATE CONFIG
// ============================================================

router.put("/", updateSettingsAsync);

// ============================================================
// RESET CONFIG
// ============================================================

router.post("/reset", resetSettingsAsync);

module.exports = router;
