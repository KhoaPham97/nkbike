const cloudinary = require("../db/cloudinary");

const uploadImageMiddleware = async (req, res, next) => {
  let fileArr = req.body.image;

  var images = [];
  try {
    for (let i = 0; i < fileArr.length; i++) {
      const uploadResponse = await cloudinary.uploader.upload(fileArr[i], {
        upload_preset: "Dev",
      });

      images.push(uploadResponse.public_id);
    }

    req.body.image = images;

    next();
  } catch (error) {
    res.status(500).send({ message: "Failed to upload image(s)" });
  }
};
const uploadImageBase64 = async (req, res, next) => {
  let fileArr = req.body.image;

  var images = [];
  try {
    const fs = require("fs");

    fs.readFile("image.png", (err, data) => {
      if (err) throw err;
      let base64Image = Buffer.from(data, "binary").toString("base64");

      req.body.image = base64Image;
    });

    next();
  } catch (error) {
    res.status(500).send({ message: "Failed to upload image(s)" });
  }
};
const editMiddleware = async (req, res, next) => {
  // we need a deleted array and the new array

  const unchangedImages = req.body.image;
  const newImages = req.body.newImages;
  const imagesToDelete = req.body.removedImages;

  let newPublicIds = [];

  try {
    // to remove the old images
    for (let i = 0; i < imagesToDelete.length; i++) {
      const response = await cloudinary.uploader.destroy(imagesToDelete[i]);
    }

    // to add the new once
    for (let i = 0; i < newImages.length; i++) {
      const response = await cloudinary.uploader.upload(newImages[i], {
        upload_preset: "Dev",
      });
      newPublicIds.push(response.public_id);
    }

    req.body.image = unchangedImages.concat(newPublicIds);
    //
    next();
  } catch (error) {
    res.status(500).send({ message: "Failed to update the images" });
  }
};

const getImageForStripeCheckoutMiddleware = async (req, res, next) => {
  let line_items = req.body.line_items;

  try {
    for (let i = 0; i < line_items.length; i++) {
      const { url } = await cloudinary.api.resource(
        line_items[i].price_data.product_data.images,
      );
      line_items[i].price_data.product_data.images = [url];
    }
    req.body.line_items = line_items;
    //
    next();
  } catch (error) {
    res.status(400).send({ message: "Failed to get images" });
  }
};

module.exports = {
  uploadImageMiddleware,
  uploadImageBase64,
  editMiddleware,
  getImageForStripeCheckoutMiddleware,
};
