// For making the apis
import express from 'express';
const router = express.Router();

// Functions
import { main as UniSwap2 } from './dexs/UniSwap2.ts';

// Honeypot detector apis
router.get('/uniswap2/:address/:address2', UniSwap2);

export default router;
