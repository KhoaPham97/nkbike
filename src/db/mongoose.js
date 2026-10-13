const mongoose = require("mongoose");

const db =
  "mongodb+srv://khoapham:khoa0403@cluster0.mtfxh4m.mongodb.net/nhatkhang";

mongoose
  .connect(db)
  .then(() => {})
  .catch((error) => {});
