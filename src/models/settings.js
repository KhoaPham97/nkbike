const mongoose = require("mongoose");

// ============================================================
// SETTINGS SCHEMA
// ============================================================

const SettingsSchema = new mongoose.Schema(
  {
    // ========================================================
    // STORE INFORMATION
    // ========================================================

    storeName: {
      type: String,
      default: "NHẬT KHANG BIKE",
      trim: true,
    },

    phone: {
      type: String,
      default: "",
      trim: true,
    },

    email: {
      type: String,
      default: "",
      trim: true,
    },

    address: {
      type: String,
      default: "",
      trim: true,
    },

    website: {
      type: String,
      default: "",
      trim: true,
    },

    logo: {
      type: String,
      default: "",
      trim: true,
    },

    // ========================================================
    // ORDER
    // ========================================================

    order: {
      allowOrder: {
        type: Boolean,
        default: true,
      },

      autoConfirm: {
        type: Boolean,
        default: false,
      },

      autoComplete: {
        type: Boolean,
        default: false,
      },

      holdMinutes: {
        type: Number,
        default: 30,
        min: 0,
      },

      allowCancel: {
        type: Boolean,
        default: true,
      },

      syncPriceBeforeComplete: {
        type: Boolean,
        default: true,
      },
    },

    // ========================================================
    // PAYMENT
    // ========================================================

    payment: {
      cash: {
        type: Boolean,
        default: true,
      },

      bankTransfer: {
        type: Boolean,
        default: true,
      },

      cod: {
        type: Boolean,
        default: true,
      },

      qrCode: {
        type: Boolean,
        default: true,
      },

      bankName: {
        type: String,
        default: "",
        trim: true,
      },

      bankAccountNumber: {
        type: String,
        default: "",
        trim: true,
      },

      bankAccountName: {
        type: String,
        default: "",
        trim: true,
      },
    },

    // ========================================================
    // SHIPPING
    // ========================================================

    shipping: {
      enabled: {
        type: Boolean,
        default: true,
      },

      defaultFee: {
        type: Number,
        default: 0,
        min: 0,
      },

      freeShippingFrom: {
        type: Number,
        default: 0,
        min: 0,
      },

      note: {
        type: String,
        default: "",
        trim: true,
      },
    },

    // ========================================================
    // PRICING
    // ========================================================

    pricing: {
      currency: {
        type: String,
        default: "VND",
        trim: true,
      },

      syncPriceForUncompletedOrders: {
        type: Boolean,
        default: true,
      },

      setPaidWhenCompleted: {
        type: Boolean,
        default: true,
      },

      useCurrentSellingPriceWhenComplete: {
        type: Boolean,
        default: true,
      },
    },

    // ========================================================
    // WEBSITE SETTINGS
    // ========================================================

    websiteSettings: {
      siteName: {
        type: String,
        default: "NHẬT KHANG BIKE",
        trim: true,
      },

      slogan: {
        type: String,
        default: "Đã chạy phải chất",
        trim: true,
      },

      maintenanceMode: {
        type: Boolean,
        default: false,
      },

      showPhone: {
        type: Boolean,
        default: true,
      },

      showAddress: {
        type: Boolean,
        default: true,
      },

      // ======================================================
      // SHOW PRICE
      //
      // true  = hiện giá sản phẩm
      // false = ẩn giá sản phẩm
      // ======================================================

      showPrice: {
        type: Boolean,
        default: false,
      },

      announcement: {
        type: String,
        default: "",
        trim: true,
      },
    },
  },
  {
    timestamps: true,
    minimize: false,
  },
);

// ============================================================
// MODEL
// ============================================================

const Settings = mongoose.model("Settings", SettingsSchema);

module.exports = Settings;
