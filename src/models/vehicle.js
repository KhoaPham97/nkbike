const mongoose = require("mongoose");

const vehicleSchema = new mongoose.Schema(
  {
    // Tên model xe
    // Ví dụ: M133, M133S, VC2021, Liwei I5
    name: {
      type: String,
      required: true,
      trim: true,
    },

    // Hãng xe
    // Ví dụ: YADEA, VC, Liwei
    brand: {
      type: String,
      trim: true,
      default: "",
    },

    // Loại xe
    // 1 = Xe đạp
    // 2 = Xe điện
    // 3 = Xe ba gác
    type: {
      type: String,
      enum: ["1", "2", "3"],
      required: true,
    },

    // Hình ảnh xe
    image: {
      type: String,
      default: "",
    },

    // Mô tả
    description: {
      type: String,
      default: "",
    },

    // Trạng thái hiển thị
    isVisible: {
      type: Boolean,
      default: true,
    },

    created_at: {
      type: Date,
      default: Date.now,
    },

    updated_at: {
      type: Date,
      default: Date.now,
    },
  },
  {
    versionKey: false,
  },
);

// ============================================
// INDEX
// ============================================

// Load xe mới nhất
vehicleSchema.index({
  created_at: -1,
});

// Tìm xe theo loại
vehicleSchema.index({
  type: 1,
});

// Tìm xe theo hãng
vehicleSchema.index({
  brand: 1,
});

// Tìm xe theo hãng + model
vehicleSchema.index({
  brand: 1,
  name: 1,
});

// Tìm xe đang hiển thị
vehicleSchema.index({
  isVisible: 1,
});

// ============================================
// MODEL
// ============================================

const Vehicle = mongoose.model("vehicles", vehicleSchema);

module.exports = {
  vehicleSchema,
  Vehicle,
};
