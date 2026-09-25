const express = require("express");
const router = express.Router();
const AnalyticsController = require("../controllers/analyticsController");

router.post("/track", AnalyticsController.trackVisit);

router.get("/dashboard", AnalyticsController.getAnalyticsDashboard);

module.exports = router;
