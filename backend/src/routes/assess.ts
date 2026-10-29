import { Hono } from 'hono';
import { z } from 'zod';
import { SYMPTOMS, assess } from '../safety';
import type { AppEnv } from '../types';
import { parseBody } from '../util';

const schema = z.object({
  systolic: z.number().int().min(50).max(300).nullable().optional(),
  diastolic: z.number().int().min(30).max(200).nullable().optional(),
  temperature_c: z.number().min(30).max(45).nullable().optional(),
  symptoms: z.array(z.enum(SYMPTOMS)).max(SYMPTOMS.length).default([]),
});

export const assessRoutes = new Hono<AppEnv>();

// Public on purpose: emergency guidance must never sit behind a login. Stores nothing.
assessRoutes.post('/assess', async (c) => c.json(assess(await parseBody(c, schema))));
