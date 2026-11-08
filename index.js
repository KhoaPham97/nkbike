const app = require("./app");
const express = require("express");
const path = require("path");
const http = require("http");
const cors = require("cors");

const { Server } = require("socket.io");
const { startShopeeAutoStockJob } = require("./src/jobs/shopeeAutoStockJob");
const chatRoutes = require("./src/routes/chatRoute");
const setupChatSocket = require("./src/socket/chatSocket");
const setupStockNotificationSocket = require("./src/socket/stockNotificationSocket");
const setupShopeeOrderSocket = require("./src/socket/shopeeOrderSocket");
const { startShopeeOrderSyncJob } = require("./src/jobs/shopeeOrderSyncJob");

// ==============================
// ENV CHECK
// ==============================
// ==============================
// HTTP SERVER
// ==============================

const server = http.createServer(app);

// ==============================
// SOCKET.IO
// ==============================

const io = new Server(server, {
  cors: {
    origin: [
      "http://localhost:3000",

      // Admin FE Render
      "https://nk-admin.onrender.com",

      // Admin FE Cloudflare
      "https://nk-admin.phamdangkhoa0403.workers.dev",
    ],

    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],

    credentials: true,
  },
});

// Cho controller sử dụng io
app.set("io", io);

// ==============================
// CORS
// ==============================

app.use(
  cors({
    origin: true,
    credentials: true,
  }),
);

// ==============================
// BODY PARSER
// ==============================

app.use(
  express.json({
    limit: "10mb",
  }),
);

app.use(
  express.urlencoded({
    extended: true,
  }),
);

// ==============================
// CHAT ROUTES
// ==============================

app.use("/api/chat", chatRoutes);

// ==============================
// SOCKET EVENTS
// ==============================

setupChatSocket(io);

// Socket thông báo tồn kho
setupStockNotificationSocket(io);
setupShopeeOrderSocket(io);
// ==============================
// FRONTEND PRODUCTION
// ==============================

// ==============================
// ROOT API
// ==============================

app.get("/", (req, res) => {
  res.send("Nhật Khang Bike API started...");
});

// ==============================
// SERVER
// ==============================

const PORT = process.env.PORT || 3001;
server.listen(PORT, async () => {
  console.log(
    `Server has started successfully in ${process.env.NODE_ENV} mode at port ${PORT}`,
  );

  // Khởi động Auto Stock độc lập.
  try {
    await startShopeeAutoStockJob();
    console.log("[Shopee Auto Stock] Khởi tạo thành công.");
  } catch (error) {
    console.error("[Shopee Auto Stock] Không thể khởi tạo:", error);
  }

  // Khởi động đồng bộ đơn hàng Shopee độc lập.
  try {
    startShopeeOrderSyncJob(io);
    console.log("[Shopee Order Sync] Khởi tạo thành công.");
  } catch (error) {
    console.error("[Shopee Order Sync] Không thể khởi tạo:", error);
  }
});
