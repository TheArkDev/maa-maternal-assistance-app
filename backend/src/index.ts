import { Hono } from 'hono';
import { adminRoutes } from './routes/admin';
import { assessRoutes } from './routes/assess';
import { authRoutes } from './routes/auth';
import { careRoutes } from './routes/care';
import { facilityRoutes } from './routes/facilities';
import { patientRoutes } from './routes/patients';
import { syncRoutes } from './routes/sync';
import type { AppEnv } from './types';
import { HttpError } from './util';

const app = new Hono<AppEnv>();

app.get('/health', (c) => c.json({ ok: true }));

app.route('/', authRoutes);
app.route('/', facilityRoutes);
app.route('/', careRoutes);
app.route('/', patientRoutes);
app.route('/', syncRoutes);
app.route('/', assessRoutes);
app.route('/', adminRoutes);

app.notFound((c) => c.json({ error: { code: 'not_found', message: 'Route not found' } }, 404));

app.onError((err, c) => {
  if (err instanceof HttpError) {
    return c.json({ error: { code: err.code, message: err.message, details: err.details } }, err.status);
  }
  console.error('Unhandled error', err);
  return c.json({ error: { code: 'internal_error', message: 'Something went wrong' } }, 500);
});

export default app;
