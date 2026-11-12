const app = require("./app");
const express = require("express");
const http = require("http");

const { Server } = require("socket.io");

const { startShopeeAutoStockJob } = require("./src/jobs/shopeeAutoStockJob");
const { startShopeeOrderSyncJob } = require("./src/jobs/shopeeOrderSyncJob");
const { startShopeeAutoReviewJob } = require("./src/jobs/shopeeAutoReviewJob");
const { startShopeeStockSyncJob } = require("./src/jobs/shopeeStockSyncJob");
const chatRoutes = require("./src/routes/chatRoute");

const setupChatSocket = require("./src/socket/chatSocket");
const setupStockNotificationSocket = require("./src/socket/stockNotificationSocket");
const setupShopeeOrderSocket = require("./src/socket/shopeeOrderSocket");
const setupShopeeReviewSocket = require("./src/socket/shopeeReviewSocket");

const server = http.createServer(app);

const socketAllowedOrigins = [
  "https://nk-admin.phamdangkhoa0403.workers.dev",
  "https://nk-admin.onrender.com",
  "http://localhost:3000",
  "http://localhost:5173",
];

const io = new Server(server, {
  cors: {
    origin: socketAllowedOrigins,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    credentials: true,
  },
});

app.set("io", io);

// CORS is configured centrally in app.js before all API routes.
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

app.use("/api/chat", chatRoutes);

setupChatSocket(io);
setupStockNotificationSocket(io);
setupShopeeOrderSocket(io);
setupShopeeReviewSocket(io);

app.get("/", (req, res) => {
  res.send("Nhật Khang Bike API started...");
});

const PORT = process.env.PORT || 3001;

server.listen(PORT, async () => {
  console.log(
    `Server has started successfully in ${process.env.NODE_ENV} mode at port ${PORT}`,
  );

  try {
    await startShopeeAutoStockJob();
    console.log("[Shopee Auto Stock] Khởi tạo thành công.");
  } catch (error) {
    console.error("[Shopee Auto Stock] Không thể khởi tạo:", error);
  }

  try {
    startShopeeOrderSyncJob(io);
    console.log("[Shopee Order Sync] Khởi tạo thành công.");
  } catch (error) {
    console.error("[Shopee Order Sync] Không thể khởi tạo:", error);
  }

  try {
    await startShopeeAutoReviewJob(io);
    console.log("[Shopee Auto Review] Khởi tạo thành công.");
  } catch (error) {
    console.error("[Shopee Auto Review] Không thể khởi tạo:", error);
  }

  try {
    await startShopeeStockSyncJob();
    console.log("[Shopee Stock Sync] Khởi tạo thành công.");
  } catch (error) {
    console.error("[Shopee Stock Sync] Không thể khởi tạo:", error);
  }
});
