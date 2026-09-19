import { Caller } from './Caller'
import { registerCaller } from '@/libs/caller/register';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL

registerCaller('api', (pinia) => new Caller(`${API_BASE_URL}/api`, pinia, { useAuth: true }));

