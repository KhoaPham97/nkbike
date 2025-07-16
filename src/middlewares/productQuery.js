const productQuery = (req, res, next) => {
  // TODO: return a search array
  const {
    priceFrom,
    priceTo,
    sortBy,
    category,
    color,
    gender,
    discount,
    currency,
  } = req.query;
  console.log(req.query);
  let sortArr = [];
  let OrArr = [];

  if (sortBy === "descending") {
    sortArr.push(["price.hkd", -1]);
  } else if (sortBy === "ascending") {
    sortArr.push(["price.hkd", 1]);
  } else {
    sortArr.push(["createdAt", -1]);
  }

  let searchArr;

  searchArr = [
    {
      $and: [
        {
          colors: {
            $regex: color === "all" ? "" : color,
          },
        },
      ],
    },
    // { $or: OrArr },
  ];

  req.query.searchArr = searchArr;
  req.query.sortArr = sortArr;
  next();
};

const productsYouMayLike = (req, res, next) => {
  const { price, gender, currency, id } = req.query;

  let searchArr;

  if (currency === "hkd") {
    searchArr = [
      {
        $and: [
          { "price.hkd": { $gte: Number(price - 400) } },
          { "price.hkd": { $lte: Number(price + 400) } },
          { _id: { $ne: id } },
        ],
      },
      { $or: [{ gender: gender }] },
    ];
  } else {
    searchArr = [
      {
        $and: [
          { "price.jpn": { $gte: Number(price - 400) } },
          { "price.jpn": { $lte: Number(price + 400) } },
          { _id: { $ne: id } },
        ],
      },
      { $or: [{ gender: gender }] },
    ];
  }

  req.query.searchArr = searchArr;

  next();
};

module.exports = { productQuery, productsYouMayLike };
