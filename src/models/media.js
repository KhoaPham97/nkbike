const mongoose = require("mongoose");

const mediaSchema = new mongoose.Schema(
  {
    filename: { type: String, required: true, trim: true },
    originalName: { type: String, default: "" },
    url: { type: String, required: true, unique: true },
    storageKey: { type: String, required: true, unique: true },
    mimeType: { type: String, required: true },
    size: { type: Number, required: true, min: 0 },
    folder: { type: String, default: "products", index: true },
    alt: { type: String, default: "" },
    uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: "users", default: null },
  },
  { timestamps: true, versionKey: false, collection: "media" },
);

mediaSchema.index({ createdAt: -1 });
mediaSchema.index({ originalName: "text", filename: "text", alt: "text" });

const Media = mongoose.models.Media || mongoose.model("Media", mediaSchema);
module.exports = { Media, mediaSchema };
