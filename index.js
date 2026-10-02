const app = require("./app");
const express = require("express");
const path = require("path");
const http = require("http");
const cors = require("cors");

const { Server } = require("socket.io");

const chatRoutes = require("./src/routes/chatRoute");
const setupChatSocket = require("./src/socket/chatSocket");

// ==============================
// ENV CHECK
// ==============================

console.log("NODE_ENV:", process.env.NODE_ENV);

console.log("JWT_SECRET:", process.env.JWT_SECRET ? "ĐÃ CÓ" : "KHÔNG CÓ");

console.log(
  "OPENAI_API_KEY:",
  process.env.OPENAI_API_KEY ? "ĐÃ CÓ KEY" : "KHÔNG CÓ KEY",
);

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

// ==============================
// FRONTEND PRODUCTION
// ==============================

if (process.env.NODE_ENV === "production") {
  const frontendPath = path.join(__dirname, "../frontend/build");

  app.use(express.static(frontendPath));

  app.get("*", (req, res) => {
    res.sendFile(
      path.resolve(__dirname, "..", "frontend", "build", "index.html"),
    );
  });
}

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

server.listen(PORT, () => {
  console.log(
    `Server has started successfully in ${process.env.NODE_ENV} mode at port ${PORT}`,
  );

  console.log(`Server running on port ${PORT}`);

  console.log(`Socket.IO is ready`);
});
