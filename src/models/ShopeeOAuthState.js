const mongoose = require("mongoose");

const schema = new mongoose.Schema({
  state: {
    type: String,
    required: true,
    unique: true,
  },
  expiresAt: {
    type: Date,
    required: true,
    expires: 0,
  },
});

module.exports =
  mongoose.models.ShopeeOAuthState ||
  mongoose.model("ShopeeOAuthState", schema);
