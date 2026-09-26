const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const morgan = require("morgan");

const dotenv = require("dotenv");
dotenv.config();

const app = express();

if (process.env.NODE_ENV === "development") {
  app.use(morgan("dev"));
}
//let __dirname = path.resolve();
app.use(express.urlencoded({ limit: "50mb", extended: true }));
app.use(express.json({ limit: "50mb" }));

const authRoute = require("./src/routes/authRoute");
const productRoute = require("./src/routes/productRoute");
const userRoute = require("./src/routes/userRoute");
const orderRoute = require("./src/routes/orderRoute");
const stripeCheckoutRoute = require("./src/routes/stripeCheckoutRoute");
const paypalCheckoutRoute = require("./src/routes/paypalCheckoutRoute");
const cartRoute = require("./src/routes/cartRoute");
const categoryRoute = require("./src/routes/categoryRoute");
const customerRouter = require("./src/routes/customerRoute");
const inventoryRouter = require("./src/routes/inventoryRouter");
const analyticsRoutes = require("./src/routes/analyticsRoutes");
const settingsRoutes = require("./src/routes/settings");
const adminRoutes = require("./src/routes/admin");
const InventoryHistory = require("./src/routes/inventoryHistoryRouter");
app.use(cors());

// Connect to MongoDB
require("./src/db/mongoose");

// connect routes
app.use(authRoute);
app.use("/api", categoryRoute);
app.use(productRoute);
app.use(userRoute);
app.use(cartRoute);
app.use(stripeCheckoutRoute);
app.use(paypalCheckoutRoute);
app.use("/api/order", orderRoute);
app.use("/api/customers", customerRouter);
app.use("/api/inventory", inventoryRouter);
// app.use("/api/products/inventory", inventoryRouter);
app.use("/api/analytics", analyticsRoutes);
app.use("/api/settings", settingsRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/inventory-history", InventoryHistory);
module.exports = app;
