import { nanoid } from 'nanoid';
import { adjectives, animals, uniqueNamesGenerator } from 'unique-names-generator';
import { POD_ID_LENGTH } from './constants.js';

export function generateId(length: number = POD_ID_LENGTH): string {
  return nanoid(length);
}

export function generatePodId(): string {
  return uniqueNamesGenerator({
    dictionaries: [adjectives, animals],
    separator: '-',
    style: 'lowerCase',
  });
}
