const jwt = require("jsonwebtoken");

const secret = process.env.JWT_SECRET;

if (!secret) {
  throw new Error("JWT_SECRET chưa được cấu hình");
}

const generateToken = async (user) => {
  const token = jwt.sign(
    {
      id: user._id.toString(),
      username: user.username,
      role: user.role,
      membership: user.membership,
    },
    secret,
    {
      expiresIn: "7d",
    },
  );

  user.tokens = user.tokens.concat({ token });

  await user.save();

  return token;
};

const verifyToken = async (token) => {
  return jwt.verify(token, secret);
};

module.exports = {
  generateToken,
  verifyToken,
};
