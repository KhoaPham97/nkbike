const mongoose = require("mongoose");
var Schema = mongoose.Schema;
var ObjectIdSchema = Schema.ObjectId;
var ObjectId = mongoose.Types.ObjectId;
const categorySchema = mongoose.Schema(
  {
    _id: {
      type: ObjectIdSchema,
      default: function () {
        return new ObjectId();
      },
    },
    id: {
      type: Number,
    },
    name: {
      type: String,
    },
    image: {
      type: String,
      image: Buffer,
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
  }
);

const Category = mongoose.model("categories", categorySchema);
module.exports = { categorySchema, Category };
