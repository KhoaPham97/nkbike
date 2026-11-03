const jwt = require("jsonwebtoken");

const setupStockNotificationSocket = (io) => {
  const namespace = io.of("/stock-notifications");

  // Xác thực JWT trước khi kết nối
  namespace.use((socket, next) => {
    try {
      const token = socket.handshake.auth?.token;

      if (!token) {
        return next(new Error("Thiếu token"));
      }

      const decoded = jwt.verify(token, process.env.JWT_SECRET);

      if (decoded.role !== "admin") {
        return next(new Error("Không có quyền Admin"));
      }

      socket.user = decoded;

      next();
    } catch (error) {
      next(new Error("Token không hợp lệ"));
    }
  });

  namespace.on("connection", (socket) => {
    console.log("Admin connected to stock notifications:", socket.id);

    socket.join("admins");

    socket.on("disconnect", () => {
      console.log("Admin disconnected:", socket.id);
    });
  });

  console.log("Stock notification socket initialized");
};

module.exports = setupStockNotificationSocket;
