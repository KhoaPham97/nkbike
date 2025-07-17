const mongoose = require("mongoose");

const db =
  "mongodb+srv://khoapham:khoa0403@cluster0.mtfxh4m.mongodb.net/nhatkhang";

mongoose
  .connect(db, {
    useUnifiedTopology: true,
  })
  .then(() => {
    console.log("Successfully connected to database");
  })
  .catch((error) => {
    console.log("Could not connect to database", error);
  });
