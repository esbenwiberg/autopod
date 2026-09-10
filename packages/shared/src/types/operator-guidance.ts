/** A worker must acknowledge this receipt after receiving its complete messages. */
export interface OperatorGuidanceDelivery {
  deliveryId: string;
  messages: string[];
}
