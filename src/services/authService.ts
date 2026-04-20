import jwt from "jsonwebtoken";

import { env } from "../config/env";
import { findValidAuthTokenByToken } from "../models/authTokenModel";
import { AuthPayload } from "../types";

export const verifyTokenAndGetUserId = async (token: string): Promise<number | null> => {
  try {
    const decoded = jwt.verify(token, env.jwtSecret) as AuthPayload;
    const storedToken = await findValidAuthTokenByToken(token);

    if (!storedToken) {
      return null;
    }

    if (storedToken.userId !== decoded.userId) {
      return null;
    }

    return decoded.userId;
  } catch (_error) {
    return null;
  }
};
