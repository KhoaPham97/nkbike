const mongoose = require("mongoose");

const Schema = mongoose.Schema;

const customerSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      trim: true,
    },
    username: {
      type: String,
      required: true,
      minlength: 4,
      maxlength: 20,
      trim: true,
      unique: true,
    },
    password: {
      type: String,
      trim: true,
      required: true,
    },
    email: {
      type: String,
      required: true,
      unique: true,
    },
    location: {
      type: String,
      trim: true,
    },
    phone: {
      type: String,
      trim: true,
    },
    orders: [
      {
        type: Schema.Types.ObjectId,
        ref: "orders",
      },
    ],

    createdAt: {
      type: Date,
      default: Date.now(),
      required: true,
    },
  },
  { timestamps: true }
);

const Customers = mongoose.model("customers", userSchema);
module.exports = { userSchema, Customers };
