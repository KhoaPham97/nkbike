const mongoose = require("mongoose");

const shopeeRevenueSnapshotSchema = new mongoose.Schema(
  {
    shopId: {
      type: String,
      required: true,
      index: true,
    },

    orderSn: {
      type: String,
      required: true,
      trim: true,
    },

    incomeStatus: {
      type: Number,
      default: 0,
    },

    currency: {
      type: String,
      default: "VND",
    },

    payoutAmount: {
      type: Number,
      default: 0,
    },

    actualPayoutTime: {
      type: Date,
      default: null,
    },

    exportedCostCny: {
      type: Number,
      default: 0,
    },

    returnedCostCny: {
      type: Number,
      default: 0,
    },

    netCostCny: {
      type: Number,
      default: 0,
    },

    exchangeRate: {
      type: Number,
      default: 0,
    },

    costVnd: {
      type: Number,
      default: 0,
    },

    profitVnd: {
      type: Number,
      default: null,
    },

    profitStatus: {
      type: String,
      enum: [
        "calculated",
        "pending_estimate",
        "missing_stock_cost",
        "needs_return_reconciliation",
      ],
      default: "missing_stock_cost",
    },

    feeBreakdown: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },

    rawIncome: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },

    rawEscrow: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },

    syncedAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: true,
    versionKey: false,
  },
);

shopeeRevenueSnapshotSchema.index({ shopId: 1, orderSn: 1 }, { unique: true });

shopeeRevenueSnapshotSchema.index({
  shopId: 1,
  actualPayoutTime: -1,
});

const ShopeeRevenueSnapshot =
  mongoose.models.ShopeeRevenueSnapshot ||
  mongoose.model("ShopeeRevenueSnapshot", shopeeRevenueSnapshotSchema);

module.exports = ShopeeRevenueSnapshot;
