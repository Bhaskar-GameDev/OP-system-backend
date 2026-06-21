/**
 * Body for the token-issue endpoints. Plain shape for now — class-validator
 * wiring lands with the bookings module (it owns request validation).
 */
export interface IssueTokenDto {
  doctorId: string;
  sessionDate: string; // 'YYYY-MM-DD'
  sessionType: 'MORNING' | 'EVENING';
}
