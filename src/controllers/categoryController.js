const { Category } = require("../models/category");

module.exports = {
  // list all category
  async listAllCategorysAsync(req, res) {
    try {
      const categorys = await Category.find().sort({
        createdAt: -1,
      });

      res.status(200).send({
        categorys,
      });
    } catch (error) {
      res.status(404).send({ message: error.message });
    }
  },

  // create a new category
  async createcategoryAsync(req, res) {
    const categoryObject = req.body;
    console.log("categoryObject", req);
    try {
      await Category.create(categoryObject);
      res.status(201).send("Successfully created a new category");
    } catch (error) {
      console.log(error.message);
      res.status(400).send({ message: error.message });
    }
  },
  // update category
  async updateCategoryAsync(req, res, next) {
    try {
      for (var i = 0; i < req.body.length; i++) {
        (async function (j) {
          const categoryId = req.body[i]._id;
          // const propsToUpdate = Object.keys(req.body[i]);
          const category = await Category.findById(categoryId);
          const array1 = ["name", "image"];

          await array1.forEach((prop) => {
            category[prop] = req.body[j][prop];
          });
          // console.log("category", category);
          await category.save();
        })(i);
      }

      res.status(200).send("successfully updated category");
    } catch (error) {
      res.send({
        message: error.message,
      });
    }
  },
  async deletecategoryAsync(req, res) {
    const categoryId = req.params.id;
    try {
      const category = await Category.findById(categoryId);
      await category.remove();

      res.status(200).send({ message: "category removed" });
    } catch (err) {
      res.send({ message: err.message });
    }
  },
  async deleteAll(req, res) {
    try {
      await Category.remove();
      res.status(200).send({ message: "category removed" });
    } catch (err) {
      res.send({ message: err.message });
    }
  },

  async getMencategory(req, res) {
    const searchArr = req.query.searchArr;
    const sortArr = req.query.sortArr;
    const pageSize = 4;
    const page = Number(req.query.pageNumber) || 1;

    try {
      const count = await category.countDocuments({ $and: searchArr });
      const mencategory = await category
        .find({
          $and: searchArr,
        })
        .sort(sortArr)
        .limit(pageSize)
        .skip(pageSize * (page - 1));

      res.status(200).send({
        mencategory,
        page,
        pages: Math.ceil(count / pageSize),
      });
    } catch (error) {
      res.status(404).send({ message: error.message });
    }
  },
  async getWomencategory(req, res) {
    const searchArr = req.query.searchArr;
    console.log(searchArr);
    const sortArr = req.query.sortArr;
    const pageSize = 4;
    const page = Number(req.query.pageNumber) || 1;

    try {
      const count = await category.countDocuments({ $and: searchArr });

      const womencategorys = await category
        .find({
          $and: searchArr,
        })
        .sort(sortArr)
        .limit(pageSize)
        .skip(pageSize * (page - 1));

      res.status(200).send({
        womencategorys,
        page,
        pages: Math.ceil(count / pageSize),
      });
    } catch (error) {
      res.status(404).send({ message: error.message });
    }
  },

  async getKidscategory(req, res) {
    const searchArr = req.query.searchArr;
    const sortArr = req.query.sortArr;
    const pageSize = 4;
    const page = Number(req.query.pageNumber) || 1;
    try {
      const count = await category.countDocuments({ $and: searchArr });
      const kidscategorys = await category
        .find({
          $and: searchArr,
        })
        .sort(sortArr)
        .limit(pageSize)
        .skip(pageSize * (page - 1));

      res.status(200).send({
        kidscategorys,
        page,
        pages: Math.ceil(count / pageSize),
      });
    } catch (error) {
      res.status(404).send({ message: error.message });
    }
  },
  async getNewArrivalscategory(req, res) {
    try {
      const newArrivals = await category
        .find({})
        .sort({ createdAt: -1 })
        .limit(3);
      res.status(200).send(newArrivals);
    } catch (error) {
      res.status(404).send({ message: error.message });
    }
  },

  async getDiscountedcategory(req, res) {
    const searchArr = req.query.searchArr;
    const sortArr = req.query.sortArr;
    const pageSize = 4;
    const page = Number(req.query.pageNumber) || 1;
    try {
      const count = await category.countDocuments({ $and: searchArr });
      const discountedcategory = await category
        .find({ $and: searchArr })
        .sort(sortArr)
        .limit(pageSize)
        .skip(pageSize * (page - 1));
      res.status(200).send({
        discountedcategory,
        page,
        pages: Math.ceil(count / pageSize),
      });
    } catch (error) {
      res.status(404).send({ message: error.message });
    }
  },
  async getcategorysYouMayLike(req, res) {
    const searchArr = req.query.searchArr;
    try {
      const categorys = await category
        .find({ $and: searchArr })
        .sort({ createdAt: -1 })
        .limit(8);

      res.status(200).send(categorys);
    } catch (error) {
      res.status(404).send({ message: error.message });
    }
  },
};
