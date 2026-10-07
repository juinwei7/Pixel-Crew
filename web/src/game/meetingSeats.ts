/**
 * War-room (作戰室) seating. Pure data so the seat order can be unit-tested.
 *
 * The table (officeDecor.ts drawMeetingArea) has four chairs on each long side,
 * at x = standX ± 11 / 33 (a roundtable seats the lead plus up to four members,
 * so eight chairs is plenty). Front-row chairs (backs to the camera) sit at the
 * meeting stand line; back-row chairs are behind the table, facing the camera.
 *
 * Seats alternate front / back, starting at the middle of the table, so two or
 * three people already sit across from each other like a meeting instead of all
 * lining up on one side.
 */
export type MeetingRow = "front" | "back" | "end";

export type MeetingSeat = { ox: number; oy: number; row: MeetingRow };

/**
 * Back-row feet offset from the meeting stand line (standY 320).
 * The table's far edge is at y 295 and its top runs down to ~306; a back-row
 * NPC standing at 298 has head and torso above the far edge and only the legs
 * hidden by the table — reads as sitting behind it, with the drawn backrest
 * (289–294) peeking out around the shoulders. At 300 a regular sprite shows
 * little more than its head; further up (26px+) the whole figure clears the
 * table and looks like it is standing on the chair.
 */
export const MEETING_BACK_OY = -22;

const F = (ox: number): MeetingSeat => ({ ox, oy: 0, row: "front" });
const B = (ox: number): MeetingSeat => ({ ox, oy: MEETING_BACK_OY, row: "back" });

export const MEETING_SEATS: readonly MeetingSeat[] = [
  F(-11), B(11),
  F(11), B(-11),
  F(-33), B(33),
  F(33), B(-33),
  // Overflow: standing at the two short ends of the table (by the screen, by the plant).
  { ox: -50, oy: -6, row: "end" },
  { ox: 52, oy: -6, row: "end" },
];

export function meetingSeat(index: number): MeetingSeat {
  const n = MEETING_SEATS.length;
  return MEETING_SEATS[((index % n) + n) % n];
}
