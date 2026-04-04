declare namespace Express {
  interface Request {
    merchant?: {
      id: string;
      name: string;
      status: string;
    };
  }
}
