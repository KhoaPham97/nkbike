const jwt = require("jsonwebtoken");

const setupShopeeOrderSocket = (io) => {
  const namespace = io.of("/shopee-orders");

  // Xác thực JWT
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
    console.log("[Shopee Socket] Admin connected:", socket.id);

    // Theo dõi tất cả gian hàng
    socket.join("shopee:admins");

    socket.on("join-shop", (shopId) => {
      if (!shopId) return;

      socket.join(`shopee:shop:${String(shopId)}`);

      console.log(`[Shopee Socket] ${socket.id} joined shop ${shopId}`);
    });

    socket.on("leave-shop", (shopId) => {
      if (!shopId) return;

      socket.leave(`shopee:shop:${String(shopId)}`);
    });

    socket.on("disconnect", () => {
      console.log("[Shopee Socket] Admin disconnected:", socket.id);
    });
  });

  console.log("[Shopee Socket] Initialized");

  return namespace;
};

module.exports = setupShopeeOrderSocket;
