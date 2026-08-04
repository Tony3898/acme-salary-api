import type { Currency } from '../../domain/money';
import type { employees } from '../schema';
import type { SalaryBands } from './bands';
import {
  COUNTRIES,
  DEPARTMENTS,
  FIRST_NAMES_FEMALE,
  FIRST_NAMES_MALE,
  FIRST_NAMES_NEUTRAL,
  JOB_LEVELS,
  LAST_NAMES,
} from './data';
import type { SeededRandom } from './random';

export type EmployeeRow = typeof employees.$inferInsert & { id: number };

/**
 * What the salary history needs, and nothing more. Kept separate from the row so
 * generation-time values — seniority, tenure, the intended salary — never have to
 * be stripped back out before inserting.
 */
export interface PayProfile {
  employeeId: number;
  hireDate: string;
  currency: Currency;
  /** What this person should be earning today. The history is built to land here. */
  currentAmountMinor: number;
}

export interface GeneratedPeople {
  rows: EmployeeRow[];
  profiles: PayProfile[];
}

/**
 * Deliberate, documented pay gap so the analysis screen has something to show —
 * random data produces none. A small within-level difference, plus fewer women at
 * senior levels, which is the honest shape of a reported gap.
 */
const GENDER_GAP_FACTOR = 0.96;
const SENIOR_RANK = 40;
const FEMALE_SHARE = 0.45;
const FEMALE_SHARE_SENIOR = 0.33;

/**
 * Held constant across levels on purpose. Deriving the male share from what is
 * left over — rather than sliding these two along with it — is what keeps the
 * unrecorded rate flat: an earlier version reported no gender for 5% of junior
 * staff but 20% of directors, which would quietly strip senior groups out of the
 * pay-gap analysis under the small-group rule.
 */
const OTHER_GENDER_SHARE = 0.03;
const UNRECORDED_GENDER_SHARE = 0.05;

/** Share of people who have left. Never anybody with reports, so no orphans. */
const LEFT_SHARE = 0.04;

/**
 * Shares paid outside their band, so both "needs attention" and the bulk-raise
 * warning about exceeding a band have real cases to show.
 */
const BELOW_BAND_SHARE = 0.07;
const ABOVE_BAND_SHARE = 0.08;

interface DraftPerson {
  row: Omit<EmployeeRow, 'id' | 'managerId'>;
  rank: number;
  currency: Currency;
  currentAmountMinor: number;
}

/**
 * Generates the company, then arranges it into a reporting hierarchy.
 *
 * People are placed most-senior-first and a manager is only ever chosen from
 * somebody already placed, which makes a single root and the absence of cycles
 * properties of the construction rather than something to check afterwards.
 */
export function generatePeople(
  count: number,
  today: string,
  bands: SalaryBands,
  random: SeededRandom,
): GeneratedPeople {
  const usedEmails = new Set<string>();
  const draft = Array.from({ length: count }, () =>
    draftPerson(today, bands, random, usedEmails),
  ).sort((left, right) => right.rank - left.rank);

  const hierarchy = new Hierarchy(random);
  const rows: EmployeeRow[] = [];
  const profiles: PayProfile[] = [];

  for (const [index, person] of draft.entries()) {
    const id = index + 1;
    rows.push({ ...person.row, id, managerId: hierarchy.place(id, person) });
    profiles.push({
      employeeId: id,
      hireDate: person.row.hireDate,
      currency: person.currency,
      currentAmountMinor: person.currentAmountMinor,
    });
  }

  markLeavers(rows, random);

  return { rows, profiles };
}

/**
 * Marks a share of people as having left, chosen only from those with nobody
 * reporting to them — a departed manager would leave their team pointing at an
 * inactive person.
 *
 * Leavers keep their salary history: what they were paid is still what they were
 * paid, and the list of who is currently employed is a matter of status rather
 * than of deleting records.
 */
function markLeavers(rows: EmployeeRow[], random: SeededRandom): void {
  const managerIds = new Set(rows.map((row) => row.managerId).filter((id) => id != null));

  for (const row of rows) {
    if (!managerIds.has(row.id) && random.chance(LEFT_SHARE)) {
      row.status = 'LEFT';
    }
  }
}

/**
 * Tracks who is eligible to manage whom as people are placed.
 *
 * Because the draft is ordered by seniority, everybody at a higher rank has
 * already been placed by the time a rank is reached — so the eligible pool is
 * simply "every earlier rank", filled in one tier at a time. That replaces
 * scanning all previously placed people for each employee, which was quadratic.
 */
class Hierarchy {
  private readonly eligible: number[] = [];
  private readonly eligibleByDepartment = new Map<number, number[]>();
  private currentTier: { id: number; departmentId: number }[] = [];
  private currentRank: number | null = null;

  constructor(private readonly random: SeededRandom) {}

  /** Returns the manager for this person, and records them for later tiers. */
  place(id: number, person: DraftPerson): number | null {
    if (this.currentRank !== null && person.rank !== this.currentRank) {
      this.promoteTierToEligible();
    }
    this.currentRank = person.rank;

    const departmentId = person.row.departmentId;
    const manager = this.chooseManager(departmentId, id);
    this.currentTier.push({ id, departmentId });
    return manager;
  }

  private promoteTierToEligible(): void {
    for (const member of this.currentTier) {
      this.eligible.push(member.id);
      const sameDepartment = this.eligibleByDepartment.get(member.departmentId) ?? [];
      sameDepartment.push(member.id);
      this.eligibleByDepartment.set(member.departmentId, sameDepartment);
    }
    this.currentTier = [];
  }

  private chooseManager(departmentId: number, id: number): number | null {
    // The most senior person reports to nobody; their peers report to them.
    if (this.eligible.length === 0) {
      return id === 1 ? null : 1;
    }

    const sameDepartment = this.eligibleByDepartment.get(departmentId);
    return this.random.pick(
      sameDepartment !== undefined && sameDepartment.length > 0 ? sameDepartment : this.eligible,
    );
  }
}

function draftPerson(
  today: string,
  bands: SalaryBands,
  random: SeededRandom,
  usedEmails: Set<string>,
): DraftPerson {
  const level = weightedPick(JOB_LEVELS, random);
  const department = weightedPick(DEPARTMENTS, random);
  const country = weightedPick(COUNTRIES, random);
  const gender = chooseGender(level.rank, random);
  const firstName = chooseFirstName(gender, random);
  const lastName = random.pick(LAST_NAMES);
  const band = bands.find(level.id, country.code);

  /* Tenure rises with seniority, so a manager is generally hired before the
     people who report to them. */
  const tenureYears = random.float(0.2, 1 + level.rank / 10);
  const genderFactor = gender === 'FEMALE' ? GENDER_GAP_FACTOR : 1;

  return {
    row: {
      fullName: `${firstName} ${lastName}`,
      email: uniqueEmail(firstName, lastName, usedEmails),
      country: country.code,
      departmentId: department.id,
      jobLevelId: level.id,
      jobTitle: random.pick(department.titles),
      hireDate: subtractYears(today, tenureYears),
      gender,
    },
    rank: level.rank,
    currency: country.currency,
    currentAmountMinor: Math.max(
      1,
      Math.round(band.midMinor * bandPosition(random) * genderFactor),
    ),
  };
}

/**
 * Where in the band this person sits, as a fraction of the midpoint. Most are
 * inside it; a documented few sit below, and a few above.
 */
function bandPosition(random: SeededRandom): number {
  if (random.chance(BELOW_BAND_SHARE)) return random.float(0.68, 0.79);
  if (random.chance(ABOVE_BAND_SHARE)) return random.float(1.26, 1.4);
  return random.float(0.86, 1.24);
}

/**
 * Fewer women at senior levels, which is the main driver of a real reported pay
 * gap. NULL means not recorded, which is distinct from OTHER — and its share does
 * not vary with seniority, so it cannot be mistaken for a signal.
 */
function chooseGender(rank: number, random: SeededRandom): EmployeeRow['gender'] {
  const femaleShare = rank >= SENIOR_RANK ? FEMALE_SHARE_SENIOR : FEMALE_SHARE;
  // Whatever seniority takes off the female share goes to male, nowhere else.
  const maleShare = 1 - femaleShare - OTHER_GENDER_SHARE - UNRECORDED_GENDER_SHARE;
  const roll = random.next();

  if (roll < femaleShare) return 'FEMALE';
  if (roll < femaleShare + maleShare) return 'MALE';
  if (roll < femaleShare + maleShare + OTHER_GENDER_SHARE) return 'OTHER';
  return null;
}

function chooseFirstName(gender: EmployeeRow['gender'], random: SeededRandom): string {
  if (gender === 'FEMALE') return random.pick(FIRST_NAMES_FEMALE);
  if (gender === 'MALE') return random.pick(FIRST_NAMES_MALE);
  return random.pick(FIRST_NAMES_NEUTRAL);
}

function uniqueEmail(firstName: string, lastName: string, used: Set<string>): string {
  const base = `${firstName}.${lastName}`.toLowerCase();
  let candidate = `${base}@acme.test`;
  let suffix = 1;

  while (used.has(candidate)) {
    suffix += 1;
    candidate = `${base}${suffix}@acme.test`;
  }

  used.add(candidate);
  return candidate;
}

function weightedPick<T extends { weight: number }>(items: readonly T[], random: SeededRandom): T {
  const totalWeight = items.reduce((total, item) => total + item.weight, 0);
  let threshold = random.float(0, totalWeight);

  for (const item of items) {
    threshold -= item.weight;
    if (threshold <= 0) return item;
  }

  // Only reachable if every weight is zero, which would be a mistake in data.ts.
  throw new Error('Cannot pick from a list with no weight.');
}

/** Calendar arithmetic on plain dates, so nothing shifts across time zones. */
function subtractYears(from: string, years: number): string {
  const date = new Date(`${from}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - Math.round(years * 365.25));
  return date.toISOString().slice(0, 10);
}
