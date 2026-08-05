import { eq } from 'drizzle-orm';
import {
  compensationRecords,
  departments,
  employees,
  fxRates,
  jobLevels,
} from '../../src/db/schema';
import type { TestDb } from './testDb';

/**
 * A small organisation with the awkward shapes the list query has to survive:
 * a reporting chain three levels deep, people outside it, four salaries that tie
 * exactly, an amount in rupees that is a large number and a small salary, a name
 * containing a percent sign, somebody who has left, a raise that has not started
 * yet, and one person with no pay recorded at all.
 *
 * Small and explicit rather than generated: every assertion below can be checked
 * by reading this, and a failure names a person rather than a row number.
 */

/** Enough to force a second page at the smallest page size. */
const FILLER_COUNT = 30;
const FILLER_AMOUNT_MINOR = 9_000_000; // $90,000.00

export interface SeededOrg {
  engineeringId: number;
  salesId: number;
  seniorLevelId: number;
  juniorLevelId: number;
  /** The manager, their report, and two more below — what a Manager may see. */
  chain: { manager: number; report: number; deep: number; deepest: number };
  outside: { lead: number; leaver: number; noPay: number };
  filler: number[];
  byEmail: Map<string, number>;
  totalEmployees: number;
}

interface PersonSpec {
  fullName: string;
  email: string;
  country: string;
  currency: 'USD' | 'GBP' | 'INR';
  departmentKey: 'engineering' | 'sales';
  levelKey: 'senior' | 'junior';
  managerEmail?: string;
  status?: 'ACTIVE' | 'LEFT';
  hireDate: string;
  /** Every compensation record for this person, in the order written. */
  pay: { amountMinor: number; effectiveFrom: string }[];
}

/**
 * Rates matching the seed's, so a figure checked by hand here means the same
 * thing in the running application.
 */
const RATES = [
  { currency: 'USD' as const, rateToUsd: '1.00000000' },
  { currency: 'GBP' as const, rateToUsd: '1.27000000' },
  { currency: 'INR' as const, rateToUsd: '0.01204000' },
];

export async function seedOrg(db: TestDb, managerEmployeeId: number): Promise<SeededOrg> {
  const [sales] = await db.insert(departments).values({ name: 'Sales' }).returning();
  const [junior] = await db.insert(jobLevels).values({ name: 'Junior', rank: 1 }).returning();
  const existing = await db.select().from(departments);
  const existingLevels = await db.select().from(jobLevels);

  const engineering = existing.find((row) => row.name === 'Engineering');
  const senior = existingLevels.find((row) => row.name === 'Senior');

  if (!sales || !junior || !engineering || !senior) {
    throw new Error('Expected the base harness to have seeded Engineering and Senior.');
  }

  await db.insert(fxRates).values(RATES.map((rate) => ({ ...rate, asOf: '2026-08-01' })));

  const manager = await requireEmployee(db, managerEmployeeId);
  const report = await requireReportOf(db, managerEmployeeId);

  const people: PersonSpec[] = [
    {
      fullName: 'Deep Report',
      email: 'deep@acme.test',
      country: 'US',
      currency: 'USD',
      departmentKey: 'engineering',
      levelKey: 'senior',
      managerEmail: report.email,
      hireDate: '2022-05-02',
      pay: [
        { amountMinor: 10_000_000, effectiveFrom: '2024-01-01' },
        // Signed off but not started: must not appear as today's salary.
        { amountMinor: 13_000_000, effectiveFrom: '2026-12-01' },
      ],
    },
    {
      fullName: 'Deepest Report',
      email: 'deepest@acme.test',
      country: 'IN',
      currency: 'INR',
      departmentKey: 'engineering',
      levelKey: 'junior',
      managerEmail: 'deep@acme.test',
      hireDate: '2023-09-11',
      // A large number and a small salary: 500,000,000 paise is about $60,200.
      pay: [{ amountMinor: 500_000_000, effectiveFrom: '2024-01-01' }],
    },
    {
      fullName: 'Outside Lead',
      email: 'outside.lead@acme.test',
      country: 'US',
      currency: 'USD',
      departmentKey: 'sales',
      levelKey: 'senior',
      hireDate: '2019-02-18',
      pay: [{ amountMinor: 15_000_000, effectiveFrom: '2024-01-01' }],
    },
    {
      fullName: 'Gone Away',
      email: 'gone@acme.test',
      country: 'US',
      currency: 'USD',
      departmentKey: 'sales',
      levelKey: 'junior',
      managerEmail: 'outside.lead@acme.test',
      status: 'LEFT',
      hireDate: '2021-07-01',
      pay: [{ amountMinor: 7_000_000, effectiveFrom: '2024-01-01' }],
    },
    {
      fullName: 'Never Paid',
      email: 'never.paid@acme.test',
      country: 'US',
      currency: 'USD',
      departmentKey: 'sales',
      levelKey: 'junior',
      managerEmail: 'outside.lead@acme.test',
      hireDate: '2026-08-01',
      // Joined, not yet on payroll. Must still appear, with no salary.
      pay: [],
    },
  ];

  for (let index = 0; index < FILLER_COUNT; index += 1) {
    /* One of them carries a percent sign, so a search for "50%" can be shown to
       match the text rather than acting as a wildcard. */
    const isPercent = index === 7;

    people.push({
      fullName: isPercent ? 'Fifty% Percent' : `Filler Number${String(index).padStart(2, '0')}`,
      email: isPercent ? 'fifty.percent@acme.test' : `filler${String(index)}@acme.test`,
      country: 'US',
      currency: 'USD',
      departmentKey: 'sales',
      levelKey: 'junior',
      managerEmail: 'outside.lead@acme.test',
      hireDate: '2024-04-01',
      // All identical, so paging has hundreds of ties to order consistently.
      pay: [{ amountMinor: FILLER_AMOUNT_MINOR, effectiveFrom: '2024-01-01' }],
    });
  }

  const departmentIds = { engineering: engineering.id, sales: sales.id };
  const levelIds = { senior: senior.id, junior: junior.id };
  const byEmail = new Map<string, number>([
    [manager.email, manager.id],
    [report.email, report.id],
  ]);

  for (const person of people) {
    const managerId = person.managerEmail === undefined ? null : byEmail.get(person.managerEmail);
    if (person.managerEmail !== undefined && managerId === undefined) {
      throw new Error(`${person.email} names a manager that has not been created yet.`);
    }

    const [inserted] = await db
      .insert(employees)
      .values({
        fullName: person.fullName,
        email: person.email,
        country: person.country,
        departmentId: departmentIds[person.departmentKey],
        jobLevelId: levelIds[person.levelKey],
        hireDate: person.hireDate,
        managerId: managerId ?? null,
        status: person.status ?? 'ACTIVE',
      })
      .returning({ id: employees.id });

    if (!inserted) {
      throw new Error(`Failed to insert ${person.email}.`);
    }
    byEmail.set(person.email, inserted.id);

    if (person.pay.length > 0) {
      await db.insert(compensationRecords).values(
        person.pay.map((entry) => ({
          employeeId: inserted.id,
          amountMinor: entry.amountMinor,
          currency: person.currency,
          effectiveFrom: entry.effectiveFrom,
        })),
      );
    }
  }

  // The manager and their report come from the base harness with no pay at all.
  await db.insert(compensationRecords).values([
    {
      employeeId: manager.id,
      amountMinor: 10_000_000,
      currency: 'GBP',
      effectiveFrom: '2024-01-01',
    },
    // A raise partway through, so "as of last year" can differ from today.
    {
      employeeId: manager.id,
      amountMinor: 12_000_000,
      currency: 'GBP',
      effectiveFrom: '2026-01-01',
    },
    { employeeId: report.id, amountMinor: 8_000_000, currency: 'GBP', effectiveFrom: '2024-01-01' },
  ]);

  const required = (email: string): number => {
    const id = byEmail.get(email);
    if (id === undefined) {
      throw new Error(`${email} was not seeded.`);
    }
    return id;
  };

  return {
    engineeringId: engineering.id,
    salesId: sales.id,
    seniorLevelId: senior.id,
    juniorLevelId: junior.id,
    chain: {
      manager: manager.id,
      report: report.id,
      deep: required('deep@acme.test'),
      deepest: required('deepest@acme.test'),
    },
    outside: {
      lead: required('outside.lead@acme.test'),
      leaver: required('gone@acme.test'),
      noPay: required('never.paid@acme.test'),
    },
    filler: people
      .filter(
        (person) => person.email.startsWith('filler') || person.email === 'fifty.percent@acme.test',
      )
      .map((person) => required(person.email)),
    byEmail,
    totalEmployees: 2 + people.length,
  };
}

async function requireEmployee(db: TestDb, id: number) {
  const [found] = await db.select().from(employees).where(eq(employees.id, id)).limit(1);
  if (!found) {
    throw new Error(`Employee ${String(id)} not found.`);
  }
  return found;
}

async function requireReportOf(db: TestDb, managerId: number) {
  const [found] = await db
    .select()
    .from(employees)
    .where(eq(employees.managerId, managerId))
    .limit(1);

  if (!found) {
    throw new Error(`Nobody reports to employee ${String(managerId)}.`);
  }
  return found;
}
