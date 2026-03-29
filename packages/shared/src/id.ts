import { nanoid } from 'nanoid';
import { adjectives, animals, uniqueNamesGenerator } from 'unique-names-generator';
import { SESSION_ID_LENGTH } from './constants.js';

export function generateId(length: number = SESSION_ID_LENGTH): string {
  return nanoid(length);
}

export function generateSessionId(): string {
  return uniqueNamesGenerator({
    dictionaries: [adjectives, animals],
    separator: '-',
    style: 'lowerCase',
  });
}
