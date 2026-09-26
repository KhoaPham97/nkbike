const mongoose = require("mongoose");
const Settings = require("../models/settings");

// ============================================================
// DEFAULT SETTINGS
// ============================================================

const DEFAULT_SETTINGS = {
  storeName: "NHẬT KHANG BIKE",
  phone: "",
  email: "",
  address: "",
  website: "",
  logo: "",

  order: {
    allowOrder: true,
    autoConfirm: false,
    autoComplete: false,
    holdMinutes: 30,
    allowCancel: true,
    syncPriceBeforeComplete: true,
  },

  payment: {
    cash: true,
    bankTransfer: true,
    cod: true,
    qrCode: true,
    bankName: "",
    bankAccountNumber: "",
    bankAccountName: "",
  },

  shipping: {
    enabled: true,
    defaultFee: 0,
    freeShippingFrom: 0,
    note: "",
  },

  pricing: {
    currency: "VND",
    syncPriceForUncompletedOrders: true,
    setPaidWhenCompleted: true,
    useCurrentSellingPriceWhenComplete: true,
  },

  websiteSettings: {
    siteName: "Nhật Khang Bike",
    slogan: "Đã chạy phải chất",
    maintenanceMode: false,
    showPhone: true,
    showAddress: true,

    // ========================================================
    // SHOW PRICE
    // true  = hiện giá
    // false = ẩn giá
    // ========================================================
    showPrice: false,

    announcement: "",
  },
};

// ============================================================
// MERGE SETTINGS
// ============================================================

const mergeSettingsWithDefault = (settings) => {
  if (!settings) {
    return {
      ...DEFAULT_SETTINGS,
    };
  }

  return {
    ...DEFAULT_SETTINGS,
    ...settings,

    order: {
      ...DEFAULT_SETTINGS.order,
      ...(settings.order || {}),
    },

    payment: {
      ...DEFAULT_SETTINGS.payment,
      ...(settings.payment || {}),
    },

    shipping: {
      ...DEFAULT_SETTINGS.shipping,
      ...(settings.shipping || {}),
    },

    pricing: {
      ...DEFAULT_SETTINGS.pricing,
      ...(settings.pricing || {}),
    },

    websiteSettings: {
      ...DEFAULT_SETTINGS.websiteSettings,
      ...(settings.websiteSettings || {}),

      // Document cũ chưa có showPrice
      showPrice:
        settings.websiteSettings?.showPrice !== undefined
          ? Boolean(settings.websiteSettings.showPrice)
          : DEFAULT_SETTINGS.websiteSettings.showPrice,
    },
  };
};

// ============================================================
// GET SETTINGS
// ============================================================

const getSettingsAsync = async (req, res) => {
  try {
    let settings = await Settings.findOne().lean();

    // --------------------------------------------------------
    // Nếu chưa có config -> tạo config mặc định
    // --------------------------------------------------------

    if (!settings) {
      settings = await Settings.create(DEFAULT_SETTINGS);
      settings = settings.toObject();
    }

    // --------------------------------------------------------
    // Merge default
    // Hỗ trợ document cũ chưa có showPrice
    // --------------------------------------------------------

    settings = mergeSettingsWithDefault(settings);

    return res.status(200).json({
      success: true,
      data: settings,
    });
  } catch (error) {
    console.error("getSettingsAsync:", error);

    return res.status(500).json({
      success: false,
      message: "Không thể lấy cấu hình hệ thống",
    });
  }
};

// ============================================================
// UPDATE SETTINGS
// ============================================================

const updateSettingsAsync = async (req, res) => {
  try {
    const data = req.body || {};

    let settings = await Settings.findOne();

    // --------------------------------------------------------
    // Nếu chưa có -> tạo mới từ DEFAULT_SETTINGS
    // --------------------------------------------------------

    if (!settings) {
      settings = new Settings(DEFAULT_SETTINGS);
    }

    // ========================================================
    // STORE
    // ========================================================

    if (data.storeName !== undefined) {
      settings.storeName = String(data.storeName).trim();
    }

    if (data.phone !== undefined) {
      settings.phone = String(data.phone).trim();
    }

    if (data.email !== undefined) {
      settings.email = String(data.email).trim();
    }

    if (data.address !== undefined) {
      settings.address = String(data.address).trim();
    }

    if (data.website !== undefined) {
      settings.website = String(data.website).trim();
    }

    if (data.logo !== undefined) {
      settings.logo = String(data.logo).trim();
    }

    // ========================================================
    // ORDER
    // ========================================================

    if (data.order) {
      settings.order = {
        ...settings.order?.toObject?.(),
        ...data.order,
      };

      if (data.order.holdMinutes !== undefined) {
        settings.order.holdMinutes = Math.max(
          Number(data.order.holdMinutes) || 0,
          0,
        );
      }
    }

    // ========================================================
    // PAYMENT
    // ========================================================

    if (data.payment) {
      settings.payment = {
        ...settings.payment?.toObject?.(),
        ...data.payment,
      };
    }

    // ========================================================
    // SHIPPING
    // ========================================================

    if (data.shipping) {
      settings.shipping = {
        ...settings.shipping?.toObject?.(),
        ...data.shipping,
      };

      if (data.shipping.defaultFee !== undefined) {
        settings.shipping.defaultFee = Math.max(
          Number(data.shipping.defaultFee) || 0,
          0,
        );
      }

      if (data.shipping.freeShippingFrom !== undefined) {
        settings.shipping.freeShippingFrom = Math.max(
          Number(data.shipping.freeShippingFrom) || 0,
          0,
        );
      }
    }

    // ========================================================
    // PRICING
    // ========================================================

    if (data.pricing) {
      settings.pricing = {
        ...settings.pricing?.toObject?.(),
        ...data.pricing,
      };
    }

    // ========================================================
    // WEBSITE SETTINGS
    // ========================================================

    if (data.websiteSettings) {
      settings.websiteSettings = {
        ...settings.websiteSettings?.toObject?.(),
        ...data.websiteSettings,
      };

      // ------------------------------------------------------
      // SHOW PRICE
      // ------------------------------------------------------

      if (data.websiteSettings.showPrice !== undefined) {
        settings.websiteSettings.showPrice = Boolean(
          data.websiteSettings.showPrice,
        );
      }
    }

    // ========================================================
    // ĐẢM BẢO SHOW PRICE LUÔN CÓ GIÁ TRỊ
    // ========================================================

    if (settings.websiteSettings?.showPrice === undefined) {
      settings.websiteSettings.showPrice =
        DEFAULT_SETTINGS.websiteSettings.showPrice;
    }

    // ========================================================
    // UPDATED BY
    // ========================================================

    if (req.user?._id && mongoose.Types.ObjectId.isValid(req.user._id)) {
      settings.updatedBy = req.user._id;
    }

    // ========================================================
    // SAVE
    // ========================================================

    await settings.save();

    return res.status(200).json({
      success: true,
      message: "Lưu cấu hình thành công",
      data: settings,
    });
  } catch (error) {
    console.error("updateSettingsAsync:", error);

    return res.status(500).json({
      success: false,
      message: error?.message || "Không thể cập nhật cấu hình",
    });
  }
};

// ============================================================
// RESET SETTINGS
// ============================================================

const resetSettingsAsync = async (req, res) => {
  try {
    let settings = await Settings.findOne();

    // --------------------------------------------------------
    // Nếu chưa có -> tạo mới
    // --------------------------------------------------------

    if (!settings) {
      settings = await Settings.create(DEFAULT_SETTINGS);
    } else {
      settings.set(DEFAULT_SETTINGS);

      if (req.user?._id && mongoose.Types.ObjectId.isValid(req.user._id)) {
        settings.updatedBy = req.user._id;
      }

      await settings.save();
    }

    return res.status(200).json({
      success: true,
      message: "Đã khôi phục cấu hình mặc định",
      data: settings,
    });
  } catch (error) {
    console.error("resetSettingsAsync:", error);

    return res.status(500).json({
      success: false,
      message: "Không thể khôi phục cấu hình",
    });
  }
};

// ============================================================
// EXPORT
// ============================================================

module.exports = {
  getSettingsAsync,
  updateSettingsAsync,
  resetSettingsAsync,
};
