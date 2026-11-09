const cron = require("node-cron");
const crypto = require("crypto");

const ShopeeShop = require("../models/ShopeeShop");
const ShopeeReviewTemplate = require("../models/ShopeeReviewTemplate");
const ShopeeReviewReplyLog = require("../models/ShopeeReviewReplyLog");
const ShopeeAutoReviewSetting = require("../models/ShopeeAutoReviewSetting");

const { getShopeeItemIds } = require("../services/shopeeService");

const {
  getShopeeReviews,
  sendShopeeReviewReply,
} = require("../services/shopeeReviewService");

// =====================================================
// CONFIG
// =====================================================

const PROCESSING_TIMEOUT_MINUTES = 30;
const LOCK_TIMEOUT_MINUTES = 120;
const REQUEST_DELAY_MS = 300;

let cronTask = null;
let ioInstance = null;
let isRunning = false;

// =====================================================
// HELPERS
// =====================================================

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function emitReview(event, data = {}) {
  if (!ioInstance) return;

  ioInstance
    .of("/shopee-reviews")
    .to("admins")
    .emit(event, {
      ...data,
      timestamp: new Date(),
    });
}

function getCommentId(review) {
  return String(review?.commentId || review?.comment_id || "").trim();
}

function getReviewTime(review) {
  const value =
    review?.createdAt ||
    review?.createTime ||
    review?.create_time ||
    review?.ctime;

  if (!value) return 0;

  const date = new Date(
    typeof value === "number" && value < 1000000000000 ? value * 1000 : value,
  );

  return Number.isNaN(date.getTime()) ? 0 : date.getTime();
}

function getShopName(shop) {
  return shop.shopName || shop.shop_name || shop.name || String(shop.shopId);
}

// getShopeeItemIds có thể trả về:
// [{ itemId: "123" }]
// hoặc ["123"]

function getItemIdsResult(result) {
  let items = [];

  if (Array.isArray(result)) {
    items = result;
  } else if (Array.isArray(result?.itemIds)) {
    items = result.itemIds;
  } else if (Array.isArray(result?.items)) {
    items = result.items;
  }

  const ids = items
    .map((item) => {
      let value;

      if (typeof item === "object" && item !== null) {
        value = item.itemId ?? item.item_id ?? item.itemID;
      } else {
        value = item;
      }

      const id = String(value ?? "").trim();

      return /^\d+$/.test(id) ? id : null;
    })
    .filter(Boolean);

  const uniqueIds = [...new Set(ids)];

  console.log("[SHOPEE] Item IDs:", {
    received: items.length,
    valid: uniqueIds.length,
    invalid: items.length - uniqueIds.length,
    sample: uniqueIds.slice(0, 5),
  });

  return uniqueIds;
}

function replacePlaceholders(template, review, shop) {
  const values = {
    "{customerName}": review.customerName || "Quý khách",
    "{rating}": String(review.rating || 5),
    "{productName}": review.itemName || review.productName || "",
    "{shopName}": getShopName(shop),
    "{orderSn}": review.orderSn || "",
  };

  let content = String(template || "");

  for (const [key, value] of Object.entries(values)) {
    content = content.split(key).join(value);
  }

  return content.trim();
}

function isUnanswered(review) {
  return (
    !review.hasReply &&
    !review.shopeeReply &&
    !review.reply &&
    !review.comment_reply?.reply
  );
}

// =====================================================
// SETTINGS
// =====================================================

async function getSetting() {
  return ShopeeAutoReviewSetting.findOneAndUpdate(
    { _id: "global" },
    {
      $setOnInsert: {
        enabled: process.env.SHOPEE_AUTO_REVIEW_ENABLED === "true",

        intervalMinutes: Number(
          process.env.SHOPEE_AUTO_REVIEW_INTERVAL_MINUTES || 1,
        ),

        maxRepliesPerRun: Number(
          process.env.SHOPEE_AUTO_REVIEW_MAX_PER_RUN || 10,
        ),

        delayBetweenRepliesMs: Number(
          process.env.SHOPEE_AUTO_REVIEW_DELAY_MS || 3000,
        ),
      },
    },
    {
      new: true,
      upsert: true,
      setDefaultsOnInsert: true,
    },
  );
}

async function getConnectedShops() {
  return ShopeeShop.find({
    shopId: {
      $exists: true,
      $ne: "",
    },
  }).lean();
}

// =====================================================
// TEMPLATE
// =====================================================

async function getTemplate(rating, shopId) {
  const filter = {
    shopId: String(shopId),
    isActive: true,
  };

  let template = await ShopeeReviewTemplate.findOne({
    ...filter,
    rating: Number(rating),
  })
    .sort({ isDefault: -1, createdAt: -1 })
    .lean();

  if (!template) {
    template = await ShopeeReviewTemplate.findOne({
      ...filter,
      rating: { $exists: false },
    })
      .sort({ isDefault: -1, createdAt: -1 })
      .lean();
  }

  if (!template) {
    template = await ShopeeReviewTemplate.findOne(filter)
      .sort({ isDefault: -1, createdAt: -1 })
      .lean();
  }

  return template;
}

// =====================================================
// CLAIM REVIEW
// =====================================================

async function claimReview(shopId, review) {
  const commentId = getCommentId(review);

  if (!commentId) return null;

  const now = new Date();

  const expiredAt = new Date(
    now.getTime() - PROCESSING_TIMEOUT_MINUTES * 60 * 1000,
  );

  const filter = {
    shopId: String(shopId),
    commentId,
    status: { $ne: "sent" },

    $or: [
      { status: "failed" },
      { status: { $exists: false } },
      { processingAt: null },
      { processingAt: { $lt: expiredAt } },
    ],
  };

  try {
    return await ShopeeReviewReplyLog.findOneAndUpdate(
      filter,
      {
        $set: {
          itemId: String(review.itemId || ""),
          rating: Number(review.rating || 0),
          customerName: review.customerName || "",
          reviewContent: review.content || "",
          status: "processing",
          processingAt: now,
          lastAttemptAt: now,
          errorMessage: "",
        },

        $inc: {
          attempts: 1,
        },

        $setOnInsert: {
          shopId: String(shopId),
          commentId,
        },
      },
      {
        new: true,
        upsert: true,
        setDefaultsOnInsert: true,
      },
    );
  } catch (error) {
    if (error.code === 11000) {
      return null;
    }

    throw error;
  }
}

// =====================================================
// MARK FAILED
// =====================================================

async function markFailed(log, error) {
  if (!log) return;

  await ShopeeReviewReplyLog.updateOne(
    {
      _id: log._id,
      status: "processing",
    },
    {
      $set: {
        status: "failed",

        errorMessage: String(error?.message || error || "Không xác định").slice(
          0,
          2000,
        ),

        processingAt: null,
      },
    },
  );
}

// =====================================================
// GET LATEST REVIEWS
//
// Chỉ lấy trang mới nhất của từng sản phẩm.
// Không quét toàn bộ lịch sử.
// =====================================================

async function getLatestReviews(shopId, itemIds, stats) {
  const reviewMap = new Map();

  let completedItems = 0;

  for (const itemId of itemIds) {
    try {
      const result = await getShopeeReviews({
        shopId,
        itemId,
        pageSize: 100,
      });

      const reviews = result?.reviews || [];

      for (const review of reviews) {
        const commentId = getCommentId(review);

        if (!commentId) continue;

        // Chống trùng đánh giá giữa các lần lấy dữ liệu.
        reviewMap.set(commentId, review);
      }

      completedItems++;

      emitReview("auto:scan-progress", {
        shopId,
        itemId,
        completedItems,
        totalItems: itemIds.length,
        loaded: reviewMap.size,
      });
    } catch (error) {
      stats.scanFailed++;

      console.error("[Shopee Auto Review] Scan item failed:", {
        shopId,
        itemId,
        message: error.message,
        code: error.code || null,
        status: error.response?.status || null,
      });

      emitReview("auto:scan-failed", {
        shopId,
        itemId,
        error: error.message,
      });
    }

    if (REQUEST_DELAY_MS > 0) {
      await sleep(REQUEST_DELAY_MS);
    }
  }

  return Array.from(reviewMap.values()).sort(
    (a, b) => getReviewTime(a) - getReviewTime(b),
  );
}

// =====================================================
// PROCESS ONE SHOP
// =====================================================

async function processShop(shop, setting, stats, budget) {
  const shopId = String(shop.shopId);

  emitReview("auto:shop-started", {
    shopId,
    shopName: getShopName(shop),
  });

  const itemResult = await getShopeeItemIds({
    shopId,
    itemStatuses: ["NORMAL"],
    pageSize: 100,
  });

  const itemIds = getItemIdsResult(itemResult);

  if (!itemIds.length) {
    emitReview("auto:shop-completed", {
      shopId,
      total: 0,
      message: "Không tìm thấy sản phẩm đang hoạt động.",
    });

    return;
  }

  console.log(
    `[Shopee Auto Review] Shop ${shopId}: quét ${itemIds.length} sản phẩm.`,
  );

  // Chỉ lấy trang đánh giá mới nhất của từng sản phẩm.
  const reviews = await getLatestReviews(shopId, itemIds, stats);

  const unanswered = reviews
    .filter(isUnanswered)
    .filter((review) => getCommentId(review));

  stats.total += unanswered.length;

  // Ưu tiên xử lý đánh giá cũ trước.
  unanswered.sort((a, b) => getReviewTime(a) - getReviewTime(b));

  let processed = 0;

  for (const review of unanswered) {
    // Giới hạn tổng số phản hồi trong một lần cron,
    // không nhân số lượng theo số gian hàng.
    if (budget.remaining <= 0) break;

    const commentId = getCommentId(review);

    const claim = await claimReview(shopId, review);

    if (!claim) {
      stats.skipped++;
      continue;
    }

    budget.remaining--;
    processed++;

    try {
      const template = await getTemplate(review.rating, shopId);

      if (!template) {
        throw new Error(
          `Chưa có mẫu trả lời đang hoạt động cho shop ${shopId}.`,
        );
      }

      const replyContent = replacePlaceholders(template.content, review, shop);

      if (!replyContent) {
        throw new Error("Nội dung phản hồi đang trống.");
      }

      if (replyContent.length > 500) {
        throw new Error("Nội dung phản hồi vượt quá 500 ký tự.");
      }

      await ShopeeReviewReplyLog.updateOne(
        { _id: claim._id },
        {
          $set: {
            replyContent,
            templateId: template._id,
          },
        },
      );

      await sendShopeeReviewReply({
        shopId,
        commentId,
        comment: replyContent,
      });

      await ShopeeReviewReplyLog.updateOne(
        {
          _id: claim._id,
          status: "processing",
        },
        {
          $set: {
            status: "sent",
            replyContent,
            templateId: template._id,
            sentAt: new Date(),
            processingAt: null,
            errorMessage: "",
          },
        },
      );

      stats.replied++;

      emitReview("auto:replied", {
        shopId,
        shopName: getShopName(shop),
        commentId,
        rating: review.rating,
        customerName: review.customerName,
        replyContent,
        stats,
      });

      console.log(
        `[Shopee Auto Review] Đã trả lời: shop=${shopId}, comment=${commentId}`,
      );
    } catch (error) {
      stats.failed++;

      await markFailed(claim, error);

      console.error("[Shopee Auto Review] Reply failed:", {
        shopId,
        commentId,
        message: error.message,
      });

      emitReview("auto:reply-failed", {
        shopId,
        commentId,
        error: error.message,
      });
    }

    emitReview("auto:progress", {
      shopId,
      stats,
      remaining: budget.remaining,
    });

    if (setting.delayBetweenRepliesMs > 0) {
      await sleep(setting.delayBetweenRepliesMs);
    }
  }

  emitReview("auto:shop-completed", {
    shopId,
    total: unanswered.length,
    processed,
    remaining: budget.remaining,
  });
}

// =====================================================
// DISTRIBUTED LOCK
// =====================================================

async function acquireLock() {
  const now = new Date();

  const expiredAt = new Date(now.getTime() - LOCK_TIMEOUT_MINUTES * 60 * 1000);

  const token = crypto.randomUUID();

  const setting = await ShopeeAutoReviewSetting.findOneAndUpdate(
    {
      _id: "global",

      $or: [
        { lockToken: "" },
        { lockToken: { $exists: false } },
        { lockedAt: null },
        { lockedAt: { $lt: expiredAt } },
      ],
    },
    {
      $set: {
        lockToken: token,
        lockedAt: now,
        isRunning: true,
        lastStatus: "running",
        lastStartedAt: now,
        lastError: "",
      },
    },
    { new: true },
  );

  return setting ? token : null;
}

async function releaseLock(token, status, error, stats) {
  await ShopeeAutoReviewSetting.updateOne(
    {
      _id: "global",
      lockToken: token,
    },
    {
      $set: {
        lockToken: "",
        lockedAt: null,
        isRunning: false,
        lastStatus: status,
        lastFinishedAt: new Date(),
        lastError: error || "",
        lastStats: stats,
      },
    },
  );
}

// =====================================================
// MAIN JOB
// =====================================================

async function runShopeeAutoReview(options = {}) {
  if (isRunning) return;

  const setting = await getSetting();

  if (!setting.enabled) return;

  // Cron chạy mỗi phút nhưng chỉ thực thi đúng interval.
  // Chạy thủ công không bị giới hạn bởi interval.
  if (options.respectInterval) {
    const lastStartedAt = setting.lastStartedAt
      ? new Date(setting.lastStartedAt).getTime()
      : 0;

    const intervalMs =
      Math.max(1, Number(setting.intervalMinutes) || 1) * 60 * 1000;

    if (lastStartedAt && Date.now() - lastStartedAt < intervalMs) {
      return;
    }
  }

  const token = await acquireLock();

  if (!token) return;

  isRunning = true;

  const stats = {
    total: 0,
    replied: 0,
    failed: 0,
    skipped: 0,
    scanFailed: 0,
  };

  const budget = {
    remaining: Math.max(1, Number(setting.maxRepliesPerRun) || 10),
  };

  let runError = "";

  emitReview("auto:started", {
    settings: {
      intervalMinutes: setting.intervalMinutes,
      maxRepliesPerRun: setting.maxRepliesPerRun,
      delayBetweenRepliesMs: setting.delayBetweenRepliesMs,
    },
  });

  try {
    const shops = await getConnectedShops();

    for (const shop of shops) {
      if (budget.remaining <= 0) break;

      const latestSetting =
        await ShopeeAutoReviewSetting.findById("global").lean();

      if (!latestSetting?.enabled) break;

      await processShop(shop, setting, stats, budget);
    }

    emitReview("auto:completed", {
      stats,
      remaining: budget.remaining,
    });

    console.log("[Shopee Auto Review] Completed:", stats);
  } catch (error) {
    runError = error.message || "Lỗi tự động trả lời";

    console.error("[Shopee Auto Review] Job failed:", error);

    emitReview("auto:error", {
      error: runError,
    });
  } finally {
    try {
      await releaseLock(
        token,
        runError ? "failed" : "completed",
        runError,
        stats,
      );
    } finally {
      isRunning = false;
    }
  }
}

// =====================================================
// CRON
//
// Kiểm tra mỗi phút.
// runShopeeAutoReview tự kiểm tra intervalMinutes.
// =====================================================

async function scheduleShopeeAutoReview() {
  const setting = await getSetting();

  if (cronTask) {
    cronTask.stop();
    cronTask = null;
  }

  if (!setting.enabled) {
    console.log("[Shopee Auto Review] Đang tắt.");
    return setting;
  }

  cronTask = cron.schedule(
    "* * * * *",
    () => {
      runShopeeAutoReview({
        respectInterval: true,
      }).catch((error) => {
        console.error("[Shopee Auto Review Cron]", error);
      });
    },
    {
      timezone: "Asia/Ho_Chi_Minh",
    },
  );

  console.log(
    `[Shopee Auto Review] Cron initialized. Interval: ${setting.intervalMinutes} minute(s).`,
  );

  return setting;
}

// =====================================================
// START
// =====================================================

async function startShopeeAutoReviewJob(io) {
  ioInstance = io;

  await scheduleShopeeAutoReview();

  console.log("[Shopee Auto Review] Cron initialized.");

  return true;
}

// =====================================================
// UPDATE SETTINGS
// =====================================================

async function updateShopeeAutoReviewSettings(data = {}) {
  const allowed = [
    "enabled",
    "intervalMinutes",
    "maxRepliesPerRun",
    "delayBetweenRepliesMs",
  ];

  const update = {};

  for (const key of allowed) {
    if (data[key] !== undefined) {
      update[key] = data[key];
    }
  }

  const setting = await ShopeeAutoReviewSetting.findOneAndUpdate(
    { _id: "global" },
    { $set: update },
    {
      new: true,
      upsert: true,
      runValidators: true,
      setDefaultsOnInsert: true,
    },
  );

  await scheduleShopeeAutoReview();

  if (setting.enabled && data.runNow === true) {
    runShopeeAutoReview().catch((error) => {
      console.error("[Shopee Auto Review]", error);
    });
  }

  emitReview("auto:settings-updated", {
    settings: setting,
  });

  return setting;
}

// =====================================================
// STATUS
// =====================================================

async function getShopeeAutoReviewStatus() {
  return getSetting();
}

// =====================================================
// STOP
// =====================================================

async function stopShopeeAutoReviewJob() {
  if (cronTask) {
    cronTask.stop();
    cronTask = null;
  }

  await ShopeeAutoReviewSetting.updateOne(
    { _id: "global" },
    {
      $set: {
        enabled: false,
      },
    },
  );

  emitReview("auto:stopped", {});
}

// =====================================================
// EXPORT
// =====================================================

module.exports = {
  startShopeeAutoReviewJob,
  runShopeeAutoReview,
  stopShopeeAutoReviewJob,
  updateShopeeAutoReviewSettings,
  getShopeeAutoReviewStatus,
  scheduleShopeeAutoReview,
};
