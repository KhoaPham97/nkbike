const { Order } = require("../models/orders");
const { User } = require("../models/user");

module.exports = {
  async addOrderItems(req, res) {
    // const { cart } = req.body;

    if (req.body.length > 0) {
      for (var i = 0; i < req.body.length; i++) {
        const {
          items,
          shippingAddress,
          paymentMethod,
          shippingCost,
          totalPrice,
          itemsPrice,
          quantity,
        } = req.body[i];
        console.log("i", req.body[i]);

        try {
          if (!items && items.length === 0) {
            throw new Error("No order items");
            return;
          }
          //   if (!delivery || !delivery.phone || !delivery.name) {
          //     throw new Error("User Information is incomplete");
          //     return;
          //   }

          //   if (!delivery.address) {
          //     throw new Error("Shipping address is required");
          //     return;
          //   }

          const order = new Order(req.body[i]);

          const createdOrder = await Order.create(order);
          //   if (delivery.userId) {
          //     const foundUser = await User.findById(delivery.userId);
          //     //   Add the order to user
          //     foundUser.orders = foundUser.orders.concat(createdOrder._id);
          //     //   Remove CartItems
          //     foundUser.cart = [];
          //     await foundUser.save();
          //   }
          // send the created orders
          res.status(201).send(createdOrder);
        } catch (error) {
          res.status(400).send({ message: error.message });
        }
      }
    }
  },
  async getOrder(req, res) {
    const orderId = req.params.id;
    try {
      const order = await Order.findById(orderId);
      res.send(order);
    } catch (error) {
      res.status(404).send({ message: error.message });
    }
  },

  async deleteOrder(req, res) {
    const orderId = req.params.id;
    try {
      const order = await Order.findById(orderId);

      const user = await User.findById(order.user.userId);

      const orders = user.orders.filter((item) => item.toString() !== orderId);

      user.orders = orders;
      await user.save();

      await order.remove();
      res.status(200).send("Successfully deleted order");
    } catch (error) {
      res.status(400).send({ message: error.message });
    }
  },
  async getAllOrders(req, res) {
    const pageSize = 10;
    const page = Number(req.query.pageNumber) || 1;

    const searchArray = [{ "delivery.phone": { $regex: req.query.phone } }];

    try {
      const count = await Order.countDocuments({ $or: searchArray });
      const orders = await Order.find({ $or: searchArray })
        .populate("delivery", "phone")
        .sort({ createdAt: -1 });

      res.status(200).send({
        orders,
        totalItem: count,
        page,
        pages: Math.ceil(count / pageSize),
      });
    } catch (error) {
      res.status(404).send({ message: error.message });
    }
  },
  async updateOrderToDelivered(req, res) {
    const orderId = req.params.id;
    try {
      const order = await Order.findById(orderId);
      if (order.isDelivered === true) {
        order.isDelivered = false;
        order.deliveredAt = null;
      } else {
        order.isDelivered = true;
        order.deliveredAt = Date.now();
      }
      const updatedOrder = await order.save();
      res.send(updatedOrder);
    } catch (error) {
      res.status(400).send({ message: error.message });
    }
  },
};
