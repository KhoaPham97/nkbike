const crypto = require("crypto");
const { Visit } = require("../models/Visit");

// =====================================================
// HASH IP
// Không lưu IP thật vào MongoDB
// =====================================================

const hashIp = (ip) => {
  if (!ip) return "";

  const secret =
    process.env.ANALYTICS_HASH_SECRET || "nhat-khang-bike-analytics";

  return crypto.createHmac("sha256", secret).update(ip).digest("hex");
};

// =====================================================
// GET CLIENT IP
// =====================================================

const getClientIp = (req) => {
  const forwarded = req.headers["x-forwarded-for"];

  if (forwarded) {
    return forwarded.split(",")[0].trim();
  }

  return req.socket?.remoteAddress || req.ip || "";
};

// =====================================================
// CLEAN STRING
// =====================================================

const cleanString = (value, maxLength = 500) => {
  if (value === undefined || value === null) {
    return "";
  }

  return String(value).trim().substring(0, maxLength);
};

// =====================================================
// NUMBER
// =====================================================

const cleanNumber = (value, defaultValue = 0) => {
  const number = Number(value);

  return Number.isFinite(number) ? number : defaultValue;
};

// =====================================================
// ARRAY STRING
// =====================================================

const cleanStringArray = (value) => {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => cleanString(item, 100))
    .filter(Boolean)
    .slice(0, 20);
};

// =====================================================
// CONTROLLER
// =====================================================

module.exports = {
  // =====================================================
  // TRACK
  // POST /api/analytics/track
  // =====================================================

  async trackVisit(req, res) {
    try {
      const body = req.body || {};

      const { sessionId, event = "page_view" } = body;

      if (!sessionId) {
        return res.status(400).json({
          success: false,
          message: "sessionId is required",
        });
      }

      // ===================================================
      // IP HASH
      // ===================================================

      const clientIp = getClientIp(req);

      const ipHash = hashIp(clientIp);

      // ===================================================
      // EVENT
      // ===================================================

      const allowedEvents = [
        "page_view",
        "product_view",
        "search",
        "add_cart",
        "checkout",
        "purchase",
        "heartbeat",
      ];

      const safeEvent = allowedEvents.includes(event) ? event : "page_view";

      // ===================================================
      // DATA
      // ===================================================

      const visit = await Visit.create({
        sessionId: cleanString(sessionId, 200),

        event: safeEvent,

        path: cleanString(body.path, 500) || "/",

        previousPath: cleanString(body.previousPath, 500),

        productId: cleanString(body.productId, 200),

        productTitle: cleanString(body.productTitle, 500),

        searchKeyword: cleanString(body.searchKeyword, 300),

        referrer: cleanString(body.referrer, 1000),

        source: cleanString(body.source, 100),

        medium: cleanString(body.medium, 100),

        campaign: cleanString(body.campaign, 200),

        // =================================================
        // DEVICE
        // =================================================

        device: cleanString(body.device, 50) || "unknown",

        browser: cleanString(body.browser, 100) || "unknown",

        browserVersion: cleanString(body.browserVersion, 50),

        os: cleanString(body.os, 100) || "unknown",

        osVersion: cleanString(body.osVersion, 50),

        platform: cleanString(body.platform, 100),

        // =================================================
        // SCREEN
        // =================================================

        screenWidth: cleanNumber(body.screenWidth),

        screenHeight: cleanNumber(body.screenHeight),

        viewportWidth: cleanNumber(body.viewportWidth),

        viewportHeight: cleanNumber(body.viewportHeight),

        pixelRatio: cleanNumber(body.pixelRatio, 1),

        touchSupport: Boolean(body.touchSupport),

        // =================================================
        // LANGUAGE
        // =================================================

        language: cleanString(body.language, 50),

        languages: cleanStringArray(body.languages),

        timezone: cleanString(body.timezone, 100),

        // =================================================
        // NETWORK
        // =================================================

        ipHash,

        userAgent: cleanString(req.headers["user-agent"], 1000),

        online: true,

        metadata:
          body.metadata && typeof body.metadata === "object"
            ? body.metadata
            : {},

        createdAt: new Date(),
      });

      return res.status(201).json({
        success: true,
        id: visit._id,
      });
    } catch (error) {
      console.error("trackVisit error:", error);

      return res.status(500).json({
        success: false,
        message: error.message,
      });
    }
  },

  // =====================================================
  // DASHBOARD
  // GET /api/analytics/dashboard
  // =====================================================

  async getAnalyticsDashboard(req, res) {
    try {
      const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 90);

      const now = new Date();

      // ===================================================
      // TODAY
      // ===================================================

      const todayStart = new Date(now);

      todayStart.setHours(0, 0, 0, 0);

      const tomorrowStart = new Date(todayStart);

      tomorrowStart.setDate(tomorrowStart.getDate() + 1);

      // ===================================================
      // PERIOD
      // ===================================================

      const startDate = new Date(todayStart);

      startDate.setDate(startDate.getDate() - (days - 1));

      // ===================================================
      // 7 DAYS
      // ===================================================

      const last7DaysStart = new Date(todayStart);

      last7DaysStart.setDate(last7DaysStart.getDate() - 6);

      // ===================================================
      // 30 DAYS
      // ===================================================

      const last30DaysStart = new Date(todayStart);

      last30DaysStart.setDate(last30DaysStart.getDate() - 29);

      // ===================================================
      // ONLINE
      // 5 phút gần nhất
      // ===================================================

      const onlineDate = new Date(Date.now() - 5 * 60 * 1000);

      // ===================================================
      // QUERIES
      // ===================================================

      const [
        totalVisits,

        uniqueVisitors,

        todayVisits,

        todayUnique,

        last7Visits,

        last7Unique,

        last30Visits,

        last30Unique,

        onlineVisitors,

        topPages,

        topProducts,

        topSearches,

        topSources,

        devices,

        browsers,

        operatingSystems,

        languages,

        screenSizes,

        dailyStats,

        recentVisits,
      ] = await Promise.all([
        // =================================================
        // TOTAL
        // =================================================

        Visit.countDocuments({
          createdAt: {
            $gte: startDate,
          },

          event: {
            $ne: "heartbeat",
          },
        }),

        // =================================================
        // UNIQUE
        // =================================================

        Visit.distinct("sessionId", {
          createdAt: {
            $gte: startDate,
          },
        }),

        // =================================================
        // TODAY
        // =================================================

        Visit.countDocuments({
          createdAt: {
            $gte: todayStart,
            $lt: tomorrowStart,
          },

          event: {
            $ne: "heartbeat",
          },
        }),

        // =================================================
        // TODAY UNIQUE
        // =================================================

        Visit.distinct("sessionId", {
          createdAt: {
            $gte: todayStart,
            $lt: tomorrowStart,
          },
        }),

        // =================================================
        // 7 DAYS
        // =================================================

        Visit.countDocuments({
          createdAt: {
            $gte: last7DaysStart,
          },

          event: {
            $ne: "heartbeat",
          },
        }),

        // =================================================
        // 7 DAYS UNIQUE
        // =================================================

        Visit.distinct("sessionId", {
          createdAt: {
            $gte: last7DaysStart,
          },
        }),

        // =================================================
        // 30 DAYS
        // =================================================

        Visit.countDocuments({
          createdAt: {
            $gte: last30DaysStart,
          },

          event: {
            $ne: "heartbeat",
          },
        }),

        // =================================================
        // 30 DAYS UNIQUE
        // =================================================

        Visit.distinct("sessionId", {
          createdAt: {
            $gte: last30DaysStart,
          },
        }),

        // =================================================
        // ONLINE
        // =================================================

        Visit.distinct("sessionId", {
          createdAt: {
            $gte: onlineDate,
          },
        }),

        // =================================================
        // TOP PAGES
        // =================================================

        Visit.aggregate([
          {
            $match: {
              createdAt: {
                $gte: startDate,
              },

              event: {
                $in: ["page_view", "product_view"],
              },
            },
          },

          {
            $group: {
              _id: "$path",

              visits: {
                $sum: 1,
              },
            },
          },

          {
            $sort: {
              visits: -1,
            },
          },

          {
            $limit: 10,
          },

          {
            $project: {
              _id: 0,

              path: "$_id",

              visits: 1,
            },
          },
        ]),

        // =================================================
        // TOP PRODUCTS
        // =================================================

        Visit.aggregate([
          {
            $match: {
              createdAt: {
                $gte: startDate,
              },

              event: {
                $in: ["product_view", "page_view"],
              },

              productId: {
                $nin: ["", null],
              },
            },
          },

          {
            $group: {
              _id: "$productId",

              title: {
                $first: "$productTitle",
              },

              views: {
                $sum: 1,
              },
            },
          },

          {
            $sort: {
              views: -1,
            },
          },

          {
            $limit: 20,
          },

          {
            $project: {
              _id: 0,

              productId: "$_id",

              title: 1,

              views: 1,
            },
          },
        ]),

        // =================================================
        // TOP SEARCHES
        // =================================================

        Visit.aggregate([
          {
            $match: {
              createdAt: {
                $gte: startDate,
              },

              event: "search",

              searchKeyword: {
                $nin: ["", null],
              },
            },
          },

          {
            $group: {
              _id: "$searchKeyword",

              searches: {
                $sum: 1,
              },
            },
          },

          {
            $sort: {
              searches: -1,
            },
          },

          {
            $limit: 20,
          },

          {
            $project: {
              _id: 0,

              keyword: "$_id",

              searches: 1,
            },
          },
        ]),

        // =================================================
        // SOURCES
        // =================================================

        Visit.aggregate([
          {
            $match: {
              createdAt: {
                $gte: startDate,
              },

              source: {
                $nin: ["", null],
              },
            },
          },

          {
            $group: {
              _id: "$source",

              visits: {
                $sum: 1,
              },
            },
          },

          {
            $sort: {
              visits: -1,
            },
          },

          {
            $limit: 20,
          },

          {
            $project: {
              _id: 0,

              source: "$_id",

              visits: 1,
            },
          },
        ]),

        // =================================================
        // DEVICE
        // =================================================

        Visit.aggregate([
          {
            $match: {
              createdAt: {
                $gte: startDate,
              },
            },
          },

          {
            $group: {
              _id: "$device",

              count: {
                $sum: 1,
              },
            },
          },

          {
            $sort: {
              count: -1,
            },
          },

          {
            $project: {
              _id: 0,

              device: "$_id",

              count: 1,
            },
          },
        ]),

        // =================================================
        // BROWSER
        // =================================================

        Visit.aggregate([
          {
            $match: {
              createdAt: {
                $gte: startDate,
              },
            },
          },

          {
            $group: {
              _id: "$browser",

              count: {
                $sum: 1,
              },
            },
          },

          {
            $sort: {
              count: -1,
            },
          },

          {
            $project: {
              _id: 0,

              browser: "$_id",

              count: 1,
            },
          },
        ]),

        // =================================================
        // OS
        // =================================================

        Visit.aggregate([
          {
            $match: {
              createdAt: {
                $gte: startDate,
              },
            },
          },

          {
            $group: {
              _id: "$os",

              count: {
                $sum: 1,
              },
            },
          },

          {
            $sort: {
              count: -1,
            },
          },

          {
            $project: {
              _id: 0,

              os: "$_id",

              count: 1,
            },
          },
        ]),

        // =================================================
        // LANGUAGE
        // =================================================

        Visit.aggregate([
          {
            $match: {
              createdAt: {
                $gte: startDate,
              },
            },
          },

          {
            $group: {
              _id: "$language",

              count: {
                $sum: 1,
              },
            },
          },

          {
            $sort: {
              count: -1,
            },
          },

          {
            $limit: 20,
          },

          {
            $project: {
              _id: 0,

              language: "$_id",

              count: 1,
            },
          },
        ]),

        // =================================================
        // SCREEN
        // =================================================

        Visit.aggregate([
          {
            $match: {
              createdAt: {
                $gte: startDate,
              },

              screenWidth: {
                $gt: 0,
              },
            },
          },

          {
            $group: {
              _id: {
                width: "$screenWidth",

                height: "$screenHeight",
              },

              count: {
                $sum: 1,
              },
            },
          },

          {
            $sort: {
              count: -1,
            },
          },

          {
            $limit: 20,
          },

          {
            $project: {
              _id: 0,

              width: "$_id.width",

              height: "$_id.height",

              count: 1,
            },
          },
        ]),

        // =================================================
        // DAILY
        // =================================================

        Visit.aggregate([
          {
            $match: {
              createdAt: {
                $gte: startDate,
              },

              event: {
                $ne: "heartbeat",
              },
            },
          },

          {
            $group: {
              _id: {
                $dateToString: {
                  format: "%Y-%m-%d",

                  date: "$createdAt",
                },
              },

              visits: {
                $sum: 1,
              },

              sessions: {
                $addToSet: "$sessionId",
              },
            },
          },

          {
            $project: {
              _id: 0,

              date: "$_id",

              visits: 1,

              unique: {
                $size: "$sessions",
              },
            },
          },

          {
            $sort: {
              date: 1,
            },
          },
        ]),

        // =================================================
        // RECENT
        // =================================================

        Visit.find()
          .sort({
            createdAt: -1,
          })
          .limit(50)
          .select(
            [
              "sessionId",
              "event",
              "path",
              "productId",
              "productTitle",
              "searchKeyword",
              "source",
              "device",
              "browser",
              "os",
              "screenWidth",
              "screenHeight",
              "language",
              "timezone",
              "createdAt",
            ].join(" "),
          )
          .lean(),
      ]);

      // =====================================================
      // RESPONSE
      // =====================================================

      return res.status(200).json({
        success: true,

        summary: {
          totalVisits,

          uniqueVisitors: uniqueVisitors.length,

          onlineVisitors: onlineVisitors.length,

          todayVisits,

          todayUniqueVisitors: todayUnique.length,

          last7DaysVisits: last7Visits,

          last7DaysUniqueVisitors: last7Unique.length,

          last30DaysVisits: last30Visits,

          last30DaysUniqueVisitors: last30Unique.length,
        },

        totalVisits,

        uniqueVisitors: uniqueVisitors.length,

        onlineVisitors: onlineVisitors.length,

        todayVisits,

        todayUniqueVisitors: todayUnique.length,

        last7DaysVisits: last7Visits,

        last7DaysUniqueVisitors: last7Unique.length,

        last30DaysVisits: last30Visits,

        last30DaysUniqueVisitors: last30Unique.length,

        topPages,

        topProducts,

        topSearches,

        topReferrers: topSources,

        devices,

        browsers,

        operatingSystems,

        languages,

        screenSizes,

        dailyStats,

        recentVisits,
      });
    } catch (error) {
      console.error("getAnalyticsDashboard error:", error);

      return res.status(500).json({
        success: false,
        message: error.message,
      });
    }
  },
};
