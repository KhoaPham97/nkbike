const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const morgan = require("morgan");

const dotenv = require("dotenv");
dotenv.config();

const app = express();

// Centralized CORS policy for storefront/admin frontends and local development.
const allowedOrigins = new Set([
  "https://nk-admin.phamdangkhoa0403.workers.dev",
  "https://nk-admin.onrender.com",
  "http://localhost:3000",
  "http://localhost:2999",
  "http://localhost:5173",
]);

const corsOptions = {
  origin(origin, callback) {
    // Allow non-browser/server-to-server requests that do not send Origin.
    if (!origin || allowedOrigins.has(origin)) {
      return callback(null, true);
    }
    return callback(new Error(`CORS blocked origin: ${origin}`));
  },
  credentials: true,
  methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "Accept", "Origin", "X-Requested-With"],
  optionsSuccessStatus: 204,
  maxAge: 86400,
};

app.use(cors(corsOptions));

if (process.env.NODE_ENV === "development") {
  app.use(morgan("dev"));
}

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
const vehicleRoutes = require("./src/routes/vehicleRoutes");
const inventoryBatchRoutes = require("./src/routes/inventoryBatch");
const costRoutes = require("./src/routes/costRoutes");
const shopeeRouter = require("./src/routes/shopeeRouter");
const shopeeManagementRouter = require("./src/routes/shopeeManagementRouter");
const shopeeInventoryRouter = require("./src/routes/shopeeInventoryRouter");
const skuRoutes = require("./src/routes/skuRoutes");
const shopeeReviewRoutes = require("./src/routes/shopeeReviewRoutes");

// Connect to MongoDB
require("./src/db/mongoose");

// Connect routes
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
app.use("/api/analytics", analyticsRoutes);
app.use("/api/settings", settingsRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/inventory-history", InventoryHistory);
app.use("/api/vehicles", vehicleRoutes);
app.use("/api/inventory-batch", inventoryBatchRoutes);
app.use("/api/admin/cost-management", costRoutes);
app.use("/api/shopee", shopeeRouter);
app.use("/api/shopee/management", shopeeManagementRouter);
app.use("/api/shopee/inventory", shopeeInventoryRouter);
app.use("/api/admin/sku", skuRoutes);
app.use("/api/shopee/reviews", shopeeReviewRoutes);

module.exports = app;
