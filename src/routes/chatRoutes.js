import express from "express";
import { chatGPT } from "../controllers/chatController.js";

const router = express.Router();

router.post("/", chatGPT);

export default router;
