const express = require("express");
const router = express.Router();
const controller = require("../controllers/orderOutcomeAnalyticsController");
const { auth, adminOnly } = require("../middlewares/auth");

router.get("/", auth, adminOnly, controller.getOrderOutcomeByProvince);

module.exports = router;
