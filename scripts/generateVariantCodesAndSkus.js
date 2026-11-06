const mongoose = require("mongoose");

// Sử dụng kết nối MongoDB hiện tại
require("../src/db/mongoose");

const { Product } = require("../src/models/products");

const VARIANT_PREFIX = "NK-";
const SKU_PREFIX = "SKU-";
const START_NUMBER = 1;

async function main() {
  try {
    await mongoose.connection.asPromise();

    const products = await Product.find({
      variants: { $exists: true, $ne: [] },
    }).lean();

    let counter = START_NUMBER;
    let totalVariants = 0;
    let updatedProducts = 0;

    for (const product of products) {
      const variants = (product.variants || []).map((variant) => {
        const number = counter++;

        totalVariants++;

        return {
          ...variant,
          variantCode: `${VARIANT_PREFIX}${number}`,
          sku: `${SKU_PREFIX}${number}`,
        };
      });

      if (!variants.length) continue;

      const result = await Product.collection.updateOne(
        { _id: product._id },
        {
          $set: { variants },
        },
      );

      if (result.modifiedCount > 0) {
        updatedProducts++;
      }

      console.log(`Updated: ${product.title || product.name || product._id}`);
    }

    console.log("\n========== COMPLETE ==========");
    console.log("Products:", updatedProducts);
    console.log("Variants:", totalVariants);
    console.log("Last number:", counter - 1);
    console.log("================================");
  } catch (error) {
    console.error("ERROR:", error);
  } finally {
    await mongoose.disconnect();
  }
}

main();
