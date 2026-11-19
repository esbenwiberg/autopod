/** Exact human discard selection. This grants deletion only, never source delivery or settlement. */
export interface ApprovalRewriteAbandonmentRequest {
  id: string;
  expectedGeneration: number;
  expectedBinding: string;
  reason: string;
  acknowledgeDataLoss: boolean;
}
