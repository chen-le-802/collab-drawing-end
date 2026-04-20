export interface ApiResponse<T> {
  code: number;
  message: string;
  data: T | null;
}

export interface UserVO {
  id: number;
  username: string;
  role: number;
  status: number;
  createdAt: string;
  updatedAt: string;
}

export interface AuthToken {
  id: number;
  userId: number;
  token: string;
  expiresAt: Date;
  createdAt: Date;
}

export interface AuthPayload {
  userId: number;
}
