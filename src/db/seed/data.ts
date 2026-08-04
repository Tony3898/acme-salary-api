import { type Currency } from '../../domain/money';

/**
 * Reference data for the seed. Everything here is synthetic: names are generated
 * combinations and pay figures are plausible rather than real market data.
 *
 * Ids are written out rather than derived from array positions, so a row can be
 * used directly after being picked — no looking an entry back up by its name.
 */

export interface SeedCountry {
  /** ISO 3166-1 alpha-2. There is no countries table; this is the employee column. */
  code: string;
  currency: Currency;
  /** Pay relative to the US for the same level, standing in for local market rates. */
  payMultiplier: number;
  rateToUsd: string;
  /** Share of headcount in this country. */
  weight: number;
}

export interface SeedDepartment {
  id: number;
  name: string;
  weight: number;
  titles: readonly string[];
}

export interface SeedJobLevel {
  id: number;
  name: string;
  /** Orders seniority. Used for the reporting hierarchy and for sorting levels. */
  rank: number;
  weight: number;
  /** Anchors the pay band, before the country multiplier is applied. */
  usdMidpoint: number;
}

/** One country per supported currency, so every employee has a rate and a band. */
export const COUNTRIES: readonly SeedCountry[] = [
  {
    code: 'US',
    currency: 'USD',
    payMultiplier: 1,
    rateToUsd: '1.00000000',
    weight: 30,
  },
  {
    code: 'GB',
    currency: 'GBP',
    payMultiplier: 0.8,
    rateToUsd: '1.27000000',
    weight: 15,
  },
  {
    code: 'DE',
    currency: 'EUR',
    payMultiplier: 0.78,
    rateToUsd: '1.08000000',
    weight: 12,
  },
  {
    code: 'CA',
    currency: 'CAD',
    payMultiplier: 0.75,
    rateToUsd: '0.73000000',
    weight: 9,
  },
  {
    code: 'AU',
    currency: 'AUD',
    payMultiplier: 0.8,
    rateToUsd: '0.66000000',
    weight: 9,
  },
  {
    code: 'IN',
    currency: 'INR',
    payMultiplier: 0.35,
    rateToUsd: '0.01204000',
    weight: 25,
  },
];

/** Roughly the shape of a 10,000-person company: engineering-heavy, small back office. */
export const DEPARTMENTS: readonly SeedDepartment[] = [
  {
    id: 1,
    name: 'Engineering',
    weight: 34,
    titles: ['Software Engineer', 'Platform Engineer', 'Data Engineer', 'QA Engineer'],
  },
  {
    id: 2,
    name: 'Sales',
    weight: 17,
    titles: ['Account Executive', 'Sales Development Representative', 'Solutions Consultant'],
  },
  {
    id: 3,
    name: 'Customer Support',
    weight: 14,
    titles: ['Support Specialist', 'Technical Support Engineer'],
  },
  {
    id: 4,
    name: 'Product',
    weight: 9,
    titles: ['Product Manager', 'Product Designer', 'UX Researcher'],
  },
  {
    id: 5,
    name: 'Marketing',
    weight: 8,
    titles: ['Marketing Manager', 'Content Strategist', 'Demand Generation Specialist'],
  },
  {
    id: 6,
    name: 'Operations',
    weight: 7,
    titles: ['Operations Analyst', 'Programme Manager', 'Facilities Coordinator'],
  },
  {
    id: 7,
    name: 'Finance',
    weight: 6,
    titles: ['Financial Analyst', 'Accountant', 'Payroll Specialist'],
  },
  {
    id: 8,
    name: 'People',
    weight: 5,
    titles: ['People Partner', 'Recruiter', 'People Operations Specialist'],
  },
];

export const JOB_LEVELS: readonly SeedJobLevel[] = [
  { id: 1, name: 'Associate', rank: 10, weight: 24, usdMidpoint: 55_000 },
  { id: 2, name: 'Professional', rank: 20, weight: 31, usdMidpoint: 80_000 },
  { id: 3, name: 'Senior', rank: 30, weight: 25, usdMidpoint: 110_000 },
  { id: 4, name: 'Lead', rank: 40, weight: 12, usdMidpoint: 145_000 },
  { id: 5, name: 'Manager', rank: 50, weight: 6, usdMidpoint: 180_000 },
  { id: 6, name: 'Director', rank: 60, weight: 2, usdMidpoint: 240_000 },
];

export const FIRST_NAMES_FEMALE: readonly string[] = [
  'Aisha',
  'Amara',
  'Anika',
  'Beatriz',
  'Camila',
  'Chloe',
  'Daniela',
  'Elena',
  'Emma',
  'Farah',
  'Grace',
  'Hannah',
  'Ingrid',
  'Isabel',
  'Jing',
  'Kavya',
  'Laila',
  'Lena',
  'Maria',
  'Meera',
  'Nadia',
  'Nora',
  'Olivia',
  'Priya',
  'Rachel',
  'Sofia',
  'Tara',
  'Valentina',
  'Yuki',
  'Zara',
];

export const FIRST_NAMES_MALE: readonly string[] = [
  'Aaron',
  'Adam',
  'Ahmed',
  'Alejandro',
  'Amir',
  'Andre',
  'Arjun',
  'Ben',
  'Carlos',
  'Daniel',
  'David',
  'Diego',
  'Ethan',
  'Felix',
  'Hiroshi',
  'Ibrahim',
  'Jonas',
  'Kenji',
  'Liam',
  'Lucas',
  'Marcus',
  'Mateo',
  'Nikhil',
  'Omar',
  'Rahul',
  'Samuel',
  'Theo',
  'Tomas',
  'Wei',
  'Yusuf',
];

export const FIRST_NAMES_NEUTRAL: readonly string[] = [
  'Alex',
  'Ari',
  'Casey',
  'Devon',
  'Eli',
  'Jamie',
  'Jordan',
  'Kai',
  'Morgan',
  'Noor',
  'Riley',
  'Rowan',
  'Sam',
  'Skyler',
  'Taylor',
];

export const LAST_NAMES: readonly string[] = [
  'Abara',
  'Ahmed',
  'Almeida',
  'Andersen',
  'Baptiste',
  'Bennett',
  'Bianchi',
  'Chen',
  'Costa',
  'Dubois',
  'Eriksen',
  'Fernandes',
  'Fisher',
  'Fontaine',
  'Garcia',
  'Gupta',
  'Hansen',
  'Hoffmann',
  'Ibrahim',
  'Iyer',
  'Jansen',
  'Kaur',
  'Keller',
  'Kimura',
  'Kowalski',
  'Larsen',
  'Lindgren',
  'Lopez',
  'Mackenzie',
  'Mehta',
  'Moreau',
  'Muller',
  'Nakamura',
  'Novak',
  'Okafor',
  'Oliveira',
  'Osei',
  'Patel',
  'Petrov',
  'Quinn',
  'Rahman',
  'Reyes',
  'Rossi',
  'Sharma',
  'Silva',
  'Tanaka',
  'Thompson',
  'Vargas',
  'Walsh',
  'Yilmaz',
];

export const RAISE_REASONS: readonly string[] = [
  'Annual review',
  'Market adjustment',
  'Promotion',
  'Performance award',
  'Retention adjustment',
];
