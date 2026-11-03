/**
 * Environment configuration.
 *
 * Works unchanged for local laptop hosting and container hosting (Railway
 * injects PORT, RAILWAY_PUBLIC_DOMAIN and optional volume paths).
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '..');
export const PUBLIC_DIR = path.join(ROOT, 'public');
export const SEED_QUESTIONS = path.join(here, 'questions.seed.json');

export const PORT = Number.parseInt(process.env.PORT || '3000', 10);
export const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(ROOT, 'data');

const generatedPin = String(Math.floor(100000 + Math.random() * 900000));
export const HOST_PIN = String(process.env.HOST_PIN || generatedPin);
export const HOST_PIN_GENERATED = !process.env.HOST_PIN;
export const PUBLIC_URL = String(process.env.PUBLIC_URL || '').replace(/\/+$/, '');

export const IS_RAILWAY = Boolean(process.env.RAILWAY_PUBLIC_DOMAIN || process.env.RAILWAY_ENVIRONMENT);
export const NODE_ENV = process.env.NODE_ENV || 'development';
