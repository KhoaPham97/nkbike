const mongoose = require("mongoose");

const shopeeStockSyncSettingSchema = new mongoose.Schema(
  {
    _id: {
      type: String,
      default: "global",
    },

    // Bật/tắt tự động đồng bộ tồn kho Shopee.
    enabled: {
      type: Boolean,
      default: false,
    },

    // Cron chạy mỗi 5 phút.
    intervalMinutes: {
      type: Number,
      default: 5,
      min: 5,
      max: 5,
    },

    // Số lần thử lại khi đồng bộ thất bại.
    maxRetries: {
      type: Number,
      default: 3,
      min: 0,
      max: 10,
    },

    // Khoảng nghỉ giữa các lần thử lại (milliseconds).
    retryDelayMs: {
      type: Number,
      default: 2000,
      min: 500,
      max: 60000,
    },

    // Số lượng dự phòng trừ thêm khỏi tồn kho.
    // Cấu hình hiện tại: 0.
    safetyBuffer: {
      type: Number,
      default: 0,
      min: 0,
    },

    lastRunAt: {
      type: Date,
      default: null,
    },

    lastSuccessAt: {
      type: Date,
      default: null,
    },

    lastErrorAt: {
      type: Date,
      default: null,
    },

    lastError: {
      type: String,
      default: "",
    },

    lastRunStatus: {
      type: String,
      enum: ["idle", "running", "success", "partial", "failed"],
      default: "idle",
    },

    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "users",
      default: null,
    },
  },
  {
    timestamps: true,
    versionKey: false,
    collection: "shopee_stock_sync_settings",
  },
);

module.exports =
  mongoose.models.ShopeeStockSyncSetting ||
  mongoose.model("ShopeeStockSyncSetting", shopeeStockSyncSettingSchema);
