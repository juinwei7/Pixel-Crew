/**
 * War-room (作戰室) seating. Pure data so the seat order can be unit-tested.
 *
 * The table (officeDecor.ts drawMeetingArea) has six chairs on each long side,
 * at x = standX ± 9 / 27 / 45. Front-row chairs (backs to the camera) sit at the
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
 * NPC standing at 300 has the torso above the far edge and the legs hidden by
 * the table — reads as sitting behind it, with the drawn backrest (290–295)
 * peeking out behind the shoulders. Further up (26–30px) the whole figure clears
 * the table and looks like it is standing on the chair.
 */
export const MEETING_BACK_OY = -20;

const F = (ox: number): MeetingSeat => ({ ox, oy: 0, row: "front" });
const B = (ox: number): MeetingSeat => ({ ox, oy: MEETING_BACK_OY, row: "back" });

export const MEETING_SEATS: readonly MeetingSeat[] = [
  F(-9), B(9),
  F(9), B(-9),
  F(-27), B(27),
  F(27), B(-27),
  F(-45), B(45),
  F(45), B(-45),
  // Overflow: standing at the two short ends of the table.
  { ox: -62, oy: -8, row: "end" },
  { ox: 62, oy: -8, row: "end" },
];

export function meetingSeat(index: number): MeetingSeat {
  const n = MEETING_SEATS.length;
  return MEETING_SEATS[((index % n) + n) % n];
}
