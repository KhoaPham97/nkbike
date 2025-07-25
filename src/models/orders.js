const mongoose = require("mongoose");

var Schema = mongoose.Schema;
var ObjectIdSchema = Schema.ObjectId;
var ObjectId = mongoose.Types.ObjectId;
const orderSchema = new mongoose.Schema(
  {
    id: {
      type: Number,
    },
    status: { type: String },
    createdAt: {
      type: Date,
      default: Date.now,
    },
    receivedAt: {
      type: Date,
      default: Date.now,
    },

    items: [
      {
        product: {
          _id: {
            type: ObjectIdSchema,

            ref: "products",
          },
          category: {
            _id: {
              type: ObjectIdSchema,

              ref: "categories",
            },
            name: {
              type: String,
            },
            image: {
              type: String,
              image: Buffer,
            },
          },
          price: { type: String },
          originalPrice: { type: String },
          name: { type: String, trim: true },
          image: [{ type: String }],
          detail: { type: String },
        },
        quantity: { type: Number },
      },
    ],

    delivery: {
      id: { type: Number },
      type: { type: String },
      alias: { type: String },
      address: { type: String },
      name: { type: String },
      phone: { type: String },
      image: { type: String, image: Buffer },
      location: { type: Object },
    },
    total: { type: Number },
    note: { type: String },
  },
  { timestamps: true }
);

const Order = mongoose.model("orders", orderSchema);
module.exports = { orderSchema, Order };
