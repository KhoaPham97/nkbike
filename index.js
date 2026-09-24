const app = require("./app");
const express = require("express");
const path = require("path");

console.log("NODE_ENV:", process.env.NODE_ENV);
console.log("JWT_SECRET:", process.env.JWT_SECRET ? "ĐÃ CÓ" : "KHÔNG CÓ");
console.log(
  "OPENAI_API_KEY:",
  process.env.OPENAI_API_KEY ? "ĐÃ CÓ KEY" : "KHÔNG CÓ KEY",
);
if (process.env.NODE_ENV === "production") {
  app.use(express.static(path.join(__dirname, "../frontend/build")));
  app.get("*", (req, res) => {
    res.sendFile(
      path.resolve(__dirname, "..", "frontend", "build", "index.html"),
    );
  });
} else {
  app.get("/", (req, res) => {
    res.send("Nhật Khang Bike API started...");
  });
}
app.get("/", (req, res) => {
  res.send("Nhật Khang Bike API started...");
});
const PORT = 3001;

app.listen(PORT, () => {
  console.log(
    `Server has started successfully in ${process.env.NODE_ENV} mode at port ${PORT}`,
  );
});
