import { render } from 'ink';
import React from 'react';
import { App } from './App.js';
import type { DashboardConfig } from './App.js';

export type { DashboardConfig };

/**
 * Render the TUI dashboard.
 * Call this from the `ap watch` CLI command.
 */
export function renderDashboard(config: DashboardConfig): void {
  render(React.createElement(App, { config }));
}
