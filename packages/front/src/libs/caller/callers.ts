import { registerCaller } from './register';
import { Caller } from './Caller';

/**
 * Empty by default, and that is the point.
 *
 * The API is served on the same origin as the interface — Vite proxies `/api` in
 * development, a single container serves both in production — so relative URLs
 * work and CORS never enters the picture. The variable exists only for the case
 * of an interface pointed at a gateway somewhere else.
 */
const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? '';

registerCaller('api', pinia => new Caller(`${API_BASE_URL}/api`, pinia, { useAuth: true }));
