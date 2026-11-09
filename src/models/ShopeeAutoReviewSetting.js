const mongoose = require("mongoose");

const ShopeeAutoReviewSettingSchema = new mongoose.Schema(
  {
    _id: {
      type: String,
      default: "global",
    },

    enabled: {
      type: Boolean,
      default: false,
    },

    intervalMinutes: {
      type: Number,
      default: 15,
      min: 1,
      max: 1440,
    },

    maxRepliesPerRun: {
      type: Number,
      default: 10,
      min: 1,
      max: 500,
    },

    delayBetweenRepliesMs: {
      type: Number,
      default: 3000,
      min: 1000,
      max: 60000,
    },

    isRunning: {
      type: Boolean,
      default: false,
    },

    lockToken: {
      type: String,
      default: "",
    },

    lockedAt: {
      type: Date,
      default: null,
    },

    lastStartedAt: {
      type: Date,
      default: null,
    },

    lastFinishedAt: {
      type: Date,
      default: null,
    },

    lastStatus: {
      type: String,
      enum: ["idle", "running", "completed", "failed"],
      default: "idle",
    },

    lastError: {
      type: String,
      default: "",
    },

    lastStats: {
      total: {
        type: Number,
        default: 0,
      },
      replied: {
        type: Number,
        default: 0,
      },
      failed: {
        type: Number,
        default: 0,
      },
      skipped: {
        type: Number,
        default: 0,
      },
    },
  },
  {
    timestamps: true,
    versionKey: false,
  },
);

module.exports =
  mongoose.models.ShopeeAutoReviewSetting ||
  mongoose.model("ShopeeAutoReviewSetting", ShopeeAutoReviewSettingSchema);
