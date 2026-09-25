const mongoose = require("mongoose");

const visitSchema = new mongoose.Schema(
  {
    // =====================================================
    // SESSION
    // =====================================================

    sessionId: {
      type: String,
      required: true,
      index: true,
    },

    // =====================================================
    // EVENT
    // page_view
    // product_view
    // search
    // add_cart
    // checkout
    // purchase
    // heartbeat
    // =====================================================

    event: {
      type: String,
      default: "page_view",
      index: true,
    },

    // =====================================================
    // PAGE
    // =====================================================

    path: {
      type: String,
      default: "/",
      index: true,
    },

    previousPath: {
      type: String,
      default: "",
    },

    // =====================================================
    // PRODUCT
    // =====================================================

    productId: {
      type: String,
      default: "",
      index: true,
    },

    productTitle: {
      type: String,
      default: "",
    },

    // =====================================================
    // SEARCH
    // =====================================================

    searchKeyword: {
      type: String,
      default: "",
      index: true,
    },

    // =====================================================
    // TRAFFIC SOURCE
    // =====================================================

    referrer: {
      type: String,
      default: "",
    },

    source: {
      type: String,
      default: "",
      index: true,
    },

    medium: {
      type: String,
      default: "",
    },

    campaign: {
      type: String,
      default: "",
    },

    // =====================================================
    // DEVICE
    // =====================================================

    device: {
      type: String,
      default: "unknown",
      index: true,
    },

    browser: {
      type: String,
      default: "unknown",
      index: true,
    },

    browserVersion: {
      type: String,
      default: "",
    },

    os: {
      type: String,
      default: "unknown",
      index: true,
    },

    osVersion: {
      type: String,
      default: "",
    },

    platform: {
      type: String,
      default: "",
    },

    // =====================================================
    // SCREEN
    // =====================================================

    screenWidth: {
      type: Number,
      default: 0,
    },

    screenHeight: {
      type: Number,
      default: 0,
    },

    viewportWidth: {
      type: Number,
      default: 0,
    },

    viewportHeight: {
      type: Number,
      default: 0,
    },

    pixelRatio: {
      type: Number,
      default: 1,
    },

    touchSupport: {
      type: Boolean,
      default: false,
    },

    // =====================================================
    // LANGUAGE
    // =====================================================

    language: {
      type: String,
      default: "",
    },

    languages: {
      type: [String],
      default: [],
    },

    timezone: {
      type: String,
      default: "",
    },

    // =====================================================
    // NETWORK
    // =====================================================

    ipHash: {
      type: String,
      default: "",
      index: true,
    },

    userAgent: {
      type: String,
      default: "",
    },

    // =====================================================
    // SESSION STATUS
    // =====================================================

    online: {
      type: Boolean,
      default: true,
    },

    // =====================================================
    // EXTRA
    // =====================================================

    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },

    // =====================================================
    // DATE
    // =====================================================

    createdAt: {
      type: Date,
      default: Date.now,
      index: true,
    },
  },
  {
    versionKey: false,
  },
);

// =====================================================
// INDEX
// =====================================================

visitSchema.index({
  sessionId: 1,
  createdAt: -1,
});

visitSchema.index({
  event: 1,
  createdAt: -1,
});

visitSchema.index({
  productId: 1,
  createdAt: -1,
});

visitSchema.index({
  path: 1,
  createdAt: -1,
});

const Visit = mongoose.models.Visit || mongoose.model("Visit", visitSchema);

module.exports = {
  Visit,
};
