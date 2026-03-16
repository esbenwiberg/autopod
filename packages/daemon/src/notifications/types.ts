import type { NotificationType } from '@autopod/shared';

export interface NotificationConfig {
  teams?: TeamsNotificationConfig;
}

export interface TeamsNotificationConfig {
  webhookUrl: string;
  enabledEvents: NotificationType[];
  profileOverrides?: Record<string, {
    enabled: boolean;
    events?: NotificationType[];
  }>;
}

export interface NotificationDecision {
  shouldSend: boolean;
  channel: 'teams';
  reason?: string;
}
