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

const LOCK_TIMEOUT_MINUTES = 10;
const HEARTBEAT_INTERVAL_MS = 60 * 1000;

const REQUEST_TIMEOUT_MS = 90 * 1000;
const PROCESSING_TIMEOUT_MINUTES = 30;

const REQUEST_DELAY_MS = 300;

let cronTask = null;
let ioInstance = null;

// =====================================================
// HELPERS
// =====================================================

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class LockLostError extends Error {
  constructor() {
    super("Cron đã mất quyền sở hữu lock. Dừng lượt chạy hiện tại.");
    this.name = "LockLostError";
  }
}

class RequestTimeoutError extends Error {
  constructor(name) {
    super(`${name} vượt quá thời gian chờ ${REQUEST_TIMEOUT_MS / 1000} giây.`);
    this.name = "RequestTimeoutError";
    this.isTimeout = true;
  }
}

function withTimeout(promise, name = "Shopee API") {
  let timer;

  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        reject(new RequestTimeoutError(name));
      }, REQUEST_TIMEOUT_MS);
    }),
  ]).finally(() => clearTimeout(timer));
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
      const value =
        typeof item === "object" && item !== null
          ? (item.itemId ?? item.item_id ?? item.itemID)
          : item;

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

        intervalMinutes: Math.max(
          1,
          Number(process.env.SHOPEE_AUTO_REVIEW_INTERVAL_MINUTES || 2),
        ),

        maxRepliesPerRun: Math.max(
          1,
          Number(process.env.SHOPEE_AUTO_REVIEW_MAX_PER_RUN || 10),
        ),

        delayBetweenRepliesMs: Math.max(
          0,
          Number(process.env.SHOPEE_AUTO_REVIEW_DELAY_MS || 3000),
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
// DISTRIBUTED LOCK
// =====================================================

async function acquireLock() {
  const now = new Date();

  const expiredAt = new Date(now.getTime() - LOCK_TIMEOUT_MINUTES * 60 * 1000);

  const token = crypto.randomUUID();

  const result = await ShopeeAutoReviewSetting.findOneAndUpdate(
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

  if (!result) return null;

  console.log("[SHOPEE CRON] Lock acquired:", token);

  return token;
}

async function renewLock(token) {
  const result = await ShopeeAutoReviewSetting.updateOne(
    {
      _id: "global",
      lockToken: token,
    },
    {
      $set: {
        lockedAt: new Date(),
        isRunning: true,
      },
    },
  );

  return result.matchedCount > 0;
}

async function assertLock(token) {
  const setting = await ShopeeAutoReviewSetting.findOne({
    _id: "global",
    lockToken: token,
  })
    .select("enabled lockToken")
    .lean();

  if (!setting || setting.lockToken !== token) {
    throw new LockLostError();
  }

  if (!setting.enabled) {
    throw new Error("Tự động trả lời Shopee đã bị tắt.");
  }
}

function startHeartbeat(token) {
  const heartbeat = setInterval(async () => {
    try {
      const renewed = await renewLock(token);

      if (!renewed) {
        console.error("[SHOPEE CRON] Không thể gia hạn lock:", token);
      } else {
        console.log("[SHOPEE CRON] Lock renewed:", token);
      }
    } catch (error) {
      console.error("[SHOPEE CRON] Heartbeat failed:", error.message);
    }
  }, HEARTBEAT_INTERVAL_MS);

  heartbeat.unref?.();

  return heartbeat;
}

async function releaseLock(token, status, error, stats) {
  const result = await ShopeeAutoReviewSetting.updateOne(
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

  if (result.matchedCount) {
    console.log("[SHOPEE CRON] Lock released:", token);
  } else {
    console.warn("[SHOPEE CRON] Lock đã thuộc về tiến trình khác:", token);
  }
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
    if (error.code === 11000) return null;
    throw error;
  }
}

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
// =====================================================

async function getLatestReviews(shopId, itemIds, stats, token) {
  const reviewMap = new Map();

  let completedItems = 0;

  for (const itemId of itemIds) {
    await assertLock(token);

    try {
      const result = await withTimeout(
        getShopeeReviews({
          shopId,
          itemId,
          pageSize: 100,
        }),
        `Lấy đánh giá sản phẩm ${itemId}`,
      );

      const reviews = result?.reviews || [];

      for (const review of reviews) {
        const commentId = getCommentId(review);

        if (commentId) {
          reviewMap.set(commentId, review);
        }
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
      if (error instanceof LockLostError) throw error;

      stats.scanFailed++;

      console.error("[SHOPEE] Scan item failed:", {
        shopId,
        itemId,
        message: error.message,
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

async function processShop(shop, setting, stats, budget, token) {
  const shopId = String(shop.shopId);

  await assertLock(token);

  emitReview("auto:shop-started", {
    shopId,
    shopName: getShopName(shop),
  });

  const itemResult = await withTimeout(
    getShopeeItemIds({
      shopId,
      itemStatuses: ["NORMAL"],
      pageSize: 100,
    }),
    `Lấy danh sách sản phẩm shop ${shopId}`,
  );

  const itemIds = getItemIdsResult(itemResult);

  if (!itemIds.length) {
    emitReview("auto:shop-completed", {
      shopId,
      total: 0,
      message: "Không tìm thấy sản phẩm đang hoạt động.",
    });

    return;
  }

  console.log(`[SHOPEE] Shop ${shopId}: quét ${itemIds.length} sản phẩm.`);

  const reviews = await getLatestReviews(shopId, itemIds, stats, token);

  await assertLock(token);

  const unanswered = reviews
    .filter(isUnanswered)
    .filter((review) => getCommentId(review));

  stats.total += unanswered.length;

  unanswered.sort((a, b) => getReviewTime(a) - getReviewTime(b));

  let processed = 0;

  for (const review of unanswered) {
    if (budget.remaining <= 0) break;

    await assertLock(token);

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

      await assertLock(token);

      await ShopeeReviewReplyLog.updateOne(
        { _id: claim._id },
        {
          $set: {
            replyContent,
            templateId: template._id,
          },
        },
      );

      await assertLock(token);

      try {
        await withTimeout(
          sendShopeeReviewReply({
            shopId,
            commentId,
            comment: replyContent,
          }),
          `Gửi phản hồi ${commentId}`,
        );
      } catch (sendError) {
        // Timeout khi gửi có thể là Shopee đã nhận
        // nhưng phản hồi HTTP chưa về.
        // Không đánh dấu failed ngay để tránh gửi trùng.
        if (sendError.isTimeout) {
          await ShopeeReviewReplyLog.updateOne(
            {
              _id: claim._id,
              status: "processing",
            },
            {
              $set: {
                errorMessage:
                  "Gửi phản hồi bị timeout. Chưa xác định Shopee đã nhận hay chưa. Sẽ kiểm tra lại sau.",
              },
            },
          );

          stats.failed++;

          emitReview("auto:reply-failed", {
            shopId,
            commentId,
            error: sendError.message,
          });

          console.error(
            "[SHOPEE] Send timeout, giữ processing để tránh gửi trùng:",
            commentId,
          );

          continue;
        }

        throw sendError;
      }

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

      console.log(`[SHOPEE] Đã trả lời shop=${shopId}, comment=${commentId}`);
    } catch (error) {
      if (error instanceof LockLostError) throw error;

      stats.failed++;

      await markFailed(claim, error);

      console.error("[SHOPEE] Reply failed:", {
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
// MAIN JOB
// =====================================================

async function executeShopeeAutoReview(options = {}) {
  const setting = await getSetting();

  if (!setting.enabled) {
    console.log("[SHOPEE CRON] Đang tắt.");
    return;
  }

  if (options.respectInterval) {
    const lastStartedAt = setting.lastStartedAt
      ? new Date(setting.lastStartedAt).getTime()
      : 0;

    const intervalMs =
      Math.max(1, Number(setting.intervalMinutes) || 2) * 60 * 1000;

    if (lastStartedAt && Date.now() - lastStartedAt < intervalMs) {
      return;
    }
  }

  const token = await acquireLock();

  if (!token) {
    console.log("[SHOPEE CRON] Bỏ qua: một tiến trình khác đang giữ lock.");
    return;
  }

  const heartbeat = startHeartbeat(token);

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
  let finalStatus = "completed";

  console.log("[SHOPEE CRON] START:", {
    token,
    intervalMinutes: setting.intervalMinutes,
    maxRepliesPerRun: budget.remaining,
  });

  emitReview("auto:started", {
    settings: {
      intervalMinutes: setting.intervalMinutes,
      maxRepliesPerRun: setting.maxRepliesPerRun,
      delayBetweenRepliesMs: setting.delayBetweenRepliesMs,
    },
  });

  try {
    const shops = await getConnectedShops();

    console.log(`[SHOPEE CRON] Có ${shops.length} shop được kết nối.`);

    for (const shop of shops) {
      await assertLock(token);

      if (budget.remaining <= 0) break;

      const latestSetting = await ShopeeAutoReviewSetting.findById("global")
        .select("enabled")
        .lean();

      if (!latestSetting?.enabled) break;

      await processShop(shop, setting, stats, budget, token);
    }

    await assertLock(token);

    emitReview("auto:completed", {
      stats,
      remaining: budget.remaining,
    });

    console.log("[SHOPEE CRON] COMPLETED:", stats);
  } catch (error) {
    runError = error.message || "Lỗi tự động trả lời";

    finalStatus = "failed";

    console.error("[SHOPEE CRON] JOB FAILED:", error);

    emitReview("auto:error", {
      error: runError,
    });
  } finally {
    clearInterval(heartbeat);

    try {
      await releaseLock(token, finalStatus, runError, stats);
    } catch (error) {
      console.error("[SHOPEE CRON] Release lock failed:", error.message);
    }

    console.log("[SHOPEE CRON] FINISHED:", {
      status: finalStatus,
      stats,
    });
  }
}

// =====================================================
// PUBLIC RUN
//
// Không dùng isRunning làm khóa chính.
// MongoDB atomic lock kiểm soát tất cả instance.
// =====================================================

async function runShopeeAutoReview(options = {}) {
  try {
    return await executeShopeeAutoReview(options);
  } catch (error) {
    console.error("[SHOPEE CRON] Unexpected error:", error);
    throw error;
  }
}

// =====================================================
// SCHEDULE
// =====================================================

async function scheduleShopeeAutoReview() {
  const setting = await getSetting();

  if (cronTask) {
    cronTask.stop();
    cronTask = null;
  }

  if (!setting.enabled) {
    console.log("[SHOPEE CRON] Đang tắt.");
    return setting;
  }

  cronTask = cron.schedule(
    "* * * * *",
    () => {
      console.log("[SHOPEE CRON] Tick:", new Date().toISOString());

      runShopeeAutoReview({
        respectInterval: true,
      }).catch((error) => {
        console.error("[SHOPEE CRON] Tick error:", error);
      });
    },
    {
      timezone: "Asia/Ho_Chi_Minh",
    },
  );

  console.log(
    `[SHOPEE CRON] Initialized. Interval: ${setting.intervalMinutes} minute(s).`,
  );

  return setting;
}

// =====================================================
// START
// =====================================================

async function startShopeeAutoReviewJob(io) {
  ioInstance = io;

  await scheduleShopeeAutoReview();

  console.log("[SHOPEE CRON] Service started.");

  return true;
}

// =====================================================
// UPDATE SETTINGS
// =====================================================

async function updateShopeeAutoReviewSettings(data = {}) {
  const update = {};

  if (data.enabled !== undefined) {
    update.enabled = Boolean(data.enabled);
  }

  if (data.intervalMinutes !== undefined) {
    update.intervalMinutes = Math.max(
      1,
      Math.min(1440, Number(data.intervalMinutes) || 1),
    );
  }

  if (data.maxRepliesPerRun !== undefined) {
    update.maxRepliesPerRun = Math.max(
      1,
      Math.min(100, Number(data.maxRepliesPerRun) || 10),
    );
  }

  if (data.delayBetweenRepliesMs !== undefined) {
    update.delayBetweenRepliesMs = Math.max(
      0,
      Math.min(60000, Number(data.delayBetweenRepliesMs) || 0),
    );
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
      console.error("[SHOPEE CRON] Manual run error:", error);
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
  const setting = await getSetting();

  const now = Date.now();

  const lockedAt = setting.lockedAt ? new Date(setting.lockedAt).getTime() : 0;

  const lockAgeMs = lockedAt ? now - lockedAt : 0;

  const lockExpired =
    Boolean(setting.lockToken) && lockAgeMs > LOCK_TIMEOUT_MINUTES * 60 * 1000;

  return {
    ...setting.toObject(),
    lockExpired,
    lockAgeMs,
    serverTime: new Date(),
  };
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

  console.log("[SHOPEE CRON] Stopped.");
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
