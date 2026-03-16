import { nanoid } from 'nanoid';
import { SESSION_ID_LENGTH } from './constants.js';

export function generateId(length: number = SESSION_ID_LENGTH): string {
  return nanoid(length);
}
