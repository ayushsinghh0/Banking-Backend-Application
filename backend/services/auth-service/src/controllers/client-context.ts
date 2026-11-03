import { Request } from 'express';
import { ClientContext } from '../services/sessions';

/** The requesting client (address as resolved behind the gateway, and User-Agent), for sessions and history */
export const clientOf = (req: Request): ClientContext => ({ ip: req.ip, userAgent: req.header('user-agent') });
