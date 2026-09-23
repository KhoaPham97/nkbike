const { Product } = require("../models/products");
const { Category } = require("../models/category");

module.exports = {
  // list all product
  async listAllProductsAsync(req, res) {
    try {
      const { type, search = "" } = req.query;

      // =====================================================
      // SEARCH
      // =====================================================
      const keyword = search.trim();

      const searchFilter = keyword
        ? {
            $or: [
              {
                title: {
                  $regex: keyword,
                  $options: "i",
                },
              },
              {
                brand: {
                  $regex: keyword,
                  $options: "i",
                },
              },
              {
                code: {
                  $regex: keyword,
                  $options: "i",
                },
              },
            ],
          }
        : {};

      // =====================================================
      // CASE 1: LOAD ALL
      // type=all hoặc không truyền type
      // Không paging
      // =====================================================
      if (!type || type === "all") {
        const products = await Product.find(searchFilter)
          .sort({ created_at: -1 })
          .lean();

        return res.status(200).json({
          products,
          total: products.length,
        });
      }

      // =====================================================
      // CASE 2: LOAD THEO TYPE
      // Có paging + search
      // =====================================================

      const page = Math.max(Number(req.query.page) || 1, 1);

      const limit = Math.min(Number(req.query.limit) || 40, 100);

      const skip = (page - 1) * limit;

      // =====================================================
      // FILTER TYPE + SEARCH
      // =====================================================

      const filter = {
        type,
        ...searchFilter,
      };

      const [products, total] = await Promise.all([
        Product.find(filter).sort({ title: 1 }).skip(skip).limit(limit).lean(),

        Product.countDocuments(filter),
      ]);

      const hasMore = page * limit < total;

      return res.status(200).json({
        products,

        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
          hasMore,
        },
      });
    } catch (error) {
      console.error("listAllProductsAsync error:", error);

      return res.status(500).json({
        message: error.message,
      });
    }
  },
  // get product by Id
  async getProductAsync(req, res) {
    const productId = req.params.id;

    try {
      const foundProduct = await Product.findById(productId);
      res.status(200).send(foundProduct);
    } catch (error) {
      res.status(404).send({ message: error.message });
    }
  },
  async deleteAll(req, res) {
    try {
      await Product.remove();
      res.status(200).send({ message: "product removed" });
    } catch (err) {
      res.send({ message: err.message });
    }
  },
  // create a new product
  async createProductAsync(req, res) {
    const productObject = req.body;
    try {
      await Product.create(productObject);
      res.status(201).send("Successfully created a new product");
    } catch (error) {
      console.log(error.message);
      res.status(400).send({ message: error.message });
    }
  },
  // get product
  async getProductByCategory(req, res, next) {
    try {
      const categoryId = req.params.id;
      const products = await Product.find({ categoryId: categoryId });
      res.status(200).send({
        products,
      });
    } catch (error) {
      res.status(404).send({ message: error.message });
    }
  },
  async searchProduct(req, res, next) {
    try {
      const search = req.query.q;
      const searchArray = [{ title: { $regex: search, $options: "i" } }];

      const products = await Product.find({ $or: searchArray }).populate(
        "title",
      );
      res.status(200).send({
        products,
      });
    } catch (error) {
      res.status(404).send({ message: error.message });
    }
  },

  // update product
  async updateProductAsync(req, res, next) {
    try {
      const allowedFields = [
        "title",
        "images",
        "detail",
        "price",
        "thumbnail",
        "rating",
        "originalPrice",
        "categoryId",
        "stock",
        "brand",
        "description",
        "variants",
      ];

      await Promise.all(
        req.body.map(async (productData) => {
          const product = await Product.findById(productData._id);

          if (!product) {
            throw new Error(`Không tìm thấy sản phẩm: ${productData._id}`);
          }

          // ==========================================
          // Cập nhật các field
          // ==========================================
          allowedFields.forEach((field) => {
            if (productData[field] !== undefined) {
              product[field] = productData[field];
            }
          });

          // ==========================================
          // TỰ ĐỘNG TÍNH TỔNG QTY TỪ VARIANTS
          // ==========================================
          if (Array.isArray(product.variants)) {
            product.qty = product.variants.reduce((total, variant) => {
              return total + (Number(variant.qty) || 0);
            }, 0);
          }

          await product.save();
        }),
      );

      return res.status(200).json({
        message: "Successfully updated products",
        total: req.body.length,
      });
    } catch (error) {
      return res.status(500).json({
        message: error.message,
      });
    }
  },

  async deleteProductAsync(req, res) {
    const productId = req.params.id;
    try {
      const product = await Product.findById(productId);
      await product.remove();

      res.status(200).send({ message: "Product removed" });
    } catch (err) {
      res.send({ message: err.message });
    }
  },

  async getMenProduct(req, res) {
    const searchArr = req.query.searchArr;
    const sortArr = req.query.sortArr;
    const pageSize = 4;
    const page = Number(req.query.pageNumber) || 1;

    try {
      const count = await Product.countDocuments({ $and: searchArr });
      const menProduct = await Product.find({
        $and: searchArr,
      })
        .sort(sortArr)
        .limit(pageSize)
        .skip(pageSize * (page - 1));

      res.status(200).send({
        menProduct,
        page,
        pages: Math.ceil(count / pageSize),
      });
    } catch (error) {
      res.status(404).send({ message: error.message });
    }
  },
  async getWomenProduct(req, res) {
    const searchArr = req.query.searchArr;
    console.log(searchArr);
    const sortArr = req.query.sortArr;
    const pageSize = 4;
    const page = Number(req.query.pageNumber) || 1;

    try {
      const count = await Product.countDocuments({ $and: searchArr });

      const womenProducts = await Product.find({
        $and: searchArr,
      })
        .sort(sortArr)
        .limit(pageSize)
        .skip(pageSize * (page - 1));

      res.status(200).send({
        womenProducts,
        page,
        pages: Math.ceil(count / pageSize),
      });
    } catch (error) {
      res.status(404).send({ message: error.message });
    }
  },

  async getKidsProduct(req, res) {
    const searchArr = req.query.searchArr;
    const sortArr = req.query.sortArr;
    const pageSize = 4;
    const page = Number(req.query.pageNumber) || 1;
    try {
      const count = await Product.countDocuments({ $and: searchArr });
      const kidsProducts = await Product.find({
        $and: searchArr,
      })
        .sort(sortArr)
        .limit(pageSize)
        .skip(pageSize * (page - 1));

      res.status(200).send({
        kidsProducts,
        page,
        pages: Math.ceil(count / pageSize),
      });
    } catch (error) {
      res.status(404).send({ message: error.message });
    }
  },
  async getNewArrivalsProduct(req, res) {
    try {
      const newArrivals = await Product.find({})
        .sort({ createdAt: -1 })
        .limit(3);
      res.status(200).send(newArrivals);
    } catch (error) {
      res.status(404).send({ message: error.message });
    }
  },

  async getDiscountedProduct(req, res) {
    const searchArr = req.query.searchArr;
    const sortArr = req.query.sortArr;
    const pageSize = 4;
    const page = Number(req.query.pageNumber) || 1;
    try {
      const count = await Product.countDocuments({ $and: searchArr });
      const discountedProduct = await Product.find({ $and: searchArr })
        .sort(sortArr)
        .limit(pageSize)
        .skip(pageSize * (page - 1));
      res.status(200).send({
        discountedProduct,
        page,
        pages: Math.ceil(count / pageSize),
      });
    } catch (error) {
      res.status(404).send({ message: error.message });
    }
  },
  async getProductsYouMayLike(req, res) {
    const searchArr = req.query.searchArr;
    try {
      const products = await Product.find({ $and: searchArr })
        .sort({ createdAt: -1 })
        .limit(8);

      res.status(200).send(products);
    } catch (error) {
      res.status(404).send({ message: error.message });
    }
  },
};
