// const mongoose = require("mongoose");

// const db =
//   "mongodb+srv://khoapham:khoa0403@cluster0.mtfxh4m.mongodb.net/nhatkhang";

// mongoose
//   .connect(db)
//   .then(() => {})
//   .catch((error) => {});
const mongoose = require("mongoose");
require("dotenv").config();

const connectDB = async () => {
  try {
    const mongoURI = process.env.MONGODB_URI;

    if (!mongoURI) {
      throw new Error("MONGODB_URI chưa được khai báo");
    }

    await mongoose.connect(mongoURI, {
      serverSelectionTimeoutMS: 10000,
    });

    console.log("MongoDB connected successfully");
    console.log("Database:", mongoose.connection.name);
  } catch (error) {
    console.error("MongoDB connection error:", error.message);
    process.exit(1);
  }
};

mongoose.connection.on("disconnected", () => {
  console.log("MongoDB disconnected");
});

connectDB();

module.exports = mongoose;
