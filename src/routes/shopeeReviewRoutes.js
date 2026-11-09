const express = require("express");
const router = express.Router();

const controller = require("../controllers/shopeeReviewController");
const reviewLogController = require("../controllers/shopeeReviewLogController");
const autoReviewController = require("../controllers/shopeeAutoReviewController");

const { auth, adminOnly } = require("../middlewares/auth");

// Không cache dữ liệu đánh giá Shopee
router.use((req, res, next) => {
  res.set(
    "Cache-Control",
    "no-store, no-cache, must-revalidate, proxy-revalidate",
  );
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");
  next();
});

// ======================================
// AUTO REPLY
// ======================================

router.get(
  "/auto-reply/status",
  auth,
  adminOnly,
  autoReviewController.getStatus,
);

router.put(
  "/auto-reply/settings",
  auth,
  adminOnly,
  autoReviewController.updateSettings,
);

router.post("/auto-reply/enable", auth, adminOnly, autoReviewController.enable);

router.post(
  "/auto-reply/disable",
  auth,
  adminOnly,
  autoReviewController.disable,
);

router.post("/auto-reply/run", auth, adminOnly, autoReviewController.runNow);

router.get(
  "/auto-reply/history",
  auth,
  adminOnly,
  autoReviewController.getHistory,
);

// ======================================
// REVIEW MANAGEMENT
// ======================================

router.get("/", auth, adminOnly, controller.getReviews);
router.get("/all", auth, adminOnly, controller.getAllReviews);

router.post("/suggest", auth, adminOnly, controller.suggestReply);

router.post("/reply", auth, adminOnly, controller.replyReview);

// ======================================
// TEMPLATES
// ======================================

router.get("/templates", auth, adminOnly, controller.getTemplates);
router.post("/templates", auth, adminOnly, controller.createTemplate);
router.put("/templates/:id", auth, adminOnly, controller.updateTemplate);
router.delete("/templates/:id", auth, adminOnly, controller.deleteTemplate);

// ======================================
// REPLY HISTORY
// ======================================

router.get("/reply-logs", auth, adminOnly, reviewLogController.getHistory);

router.get(
  "/reply-logs/statistics",
  auth,
  adminOnly,
  reviewLogController.getStatistics,
);

router.get(
  "/reply-logs/:commentId",
  auth,
  adminOnly,
  reviewLogController.getDetail,
);

module.exports = router;
