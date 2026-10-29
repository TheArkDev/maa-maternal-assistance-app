export type Env = {
  DB: D1Database;
  JWT_SECRET: string;
  ADMIN_API_KEY: string;
};

export type AuthUser = { id: string; role: 'mother' | 'staff' };

export type AppEnv = {
  Bindings: Env;
  Variables: { user: AuthUser };
};

export type RiskLevel = 'routine' | 'urgent' | 'emergency';
