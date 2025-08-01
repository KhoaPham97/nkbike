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
app.use(cors());

// Connect to MongoDB
require("./src/db/mongoose");

// connect routes
app.use(authRoute);
app.use(categoryRoute);
app.use(productRoute);
app.use(userRoute);
app.use(orderRoute);
app.use(cartRoute);
app.use(stripeCheckoutRoute);
app.use(paypalCheckoutRoute);

module.exports = app;
