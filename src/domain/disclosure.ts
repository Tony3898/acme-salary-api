/**
 * What is small enough that publishing it would be publishing somebody's salary.
 *
 * This is a policy rather than a query detail, which is why it lives here and not
 * in whichever query happened to need it first. Three separate features now lean
 * on it — the dashboard's group medians, the pay-gap cells, and the note the UI
 * shows in place of a suppressed figure — and it has to be the same number in all
 * three or the suppression can be undone by comparing two screens.
 */

/**
 * Below this, a group's median is that group's salaries with one step of
 * arithmetic in front.
 *
 * Five is the smallest size where the middle value is not simply somebody's pay:
 * at two it is the average of both, at three it is the middle person's exactly. A
 * headcount and a total are still reported for smaller groups, because those are
 * genuinely aggregate — the median is the one that leaks.
 *
 * The consequence worth knowing: splitting 10,000 people by country, level and
 * gender leaves real cells with three or four people in them, and those cells
 * disappear from the analysis rather than showing a "gap" that is one person's
 * salary. The response says how many were suppressed, so the gap in the data is
 * visible even when the data is not.
 */
export const MIN_GROUP_FOR_MEDIAN = 5;
