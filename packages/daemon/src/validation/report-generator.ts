import type { Pod } from '@autopod/shared';
import type { StoredValidation } from '../pods/validation-repository.js';

/**
 * Generates a self-contained HTML validation report for a pod.
 * Tailwind CDN for styling, no external dependencies.
 */
export function generateValidationReport(
  pod: Pod,
  validations: StoredValidation[],
  /** Pod-scoped auth token — passed to preview API calls */
  podToken?: string,
): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Validation Report — ${escapeHtml(pod.id)}</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <style>
    .tab-content { display: none; }
    .tab-content.active { display: block; }
    .tab-btn.active { border-color: rgb(59 130 246); color: rgb(59 130 246); background: rgb(239 246 255); }
    pre { white-space: pre-wrap; word-break: break-word; }
  </style>
</head>
<body class="bg-gray-50 text-gray-900 min-h-screen">
  <div class="max-w-5xl mx-auto px-4 py-8">
    ${renderHeader(pod)}
    ${renderPreviewSection(pod)}
    ${renderAttemptTimeline(validations)}
    ${validations.length === 0 ? renderNoValidations() : validations.map((v, i) => renderAttempt(v, i, validations.length)).join('\n')}
  </div>
  <script>
    function showTab(attempt) {
      document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
      document.querySelectorAll('.tab-btn').forEach(el => el.classList.remove('active'));
      const content = document.getElementById('attempt-' + attempt);
      const btn = document.getElementById('tab-' + attempt);
      if (content) content.classList.add('active');
      if (btn) btn.classList.add('active');
    }
    // Show the latest attempt by default
    ${validations.length > 0 ? `showTab(${validations[validations.length - 1].attempt});` : ''}

    // ── Preview controls ──
    var _sessionToken = ${podToken ? `'${escapeHtml(podToken)}'` : 'null'};
    function _previewUrl(path) {
      var url = window.location.origin + path;
      if (_sessionToken) url += (path.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(_sessionToken);
      return url;
    }

    async function startPreview() {
      const btn = document.getElementById('preview-start-btn');
      const status = document.getElementById('preview-status');
      if (btn) btn.disabled = true;
      if (btn) btn.textContent = 'Starting…';
      try {
        const res = await fetch(_previewUrl('/pods/${escapeHtml(pod.id)}/preview'), { method: 'POST' });
        const data = await res.json();
        if (!res.ok) throw new Error(data.message || 'Failed to start preview');
        if (status) status.innerHTML = 'Preview running at <a href="' + data.previewUrl + '" target="_blank" class="text-blue-600 underline">' + data.previewUrl + '</a>';
        if (btn) btn.textContent = 'Restart Preview';
        if (btn) btn.disabled = false;
        const stopBtn = document.getElementById('preview-stop-btn');
        if (stopBtn) stopBtn.classList.remove('hidden');
      } catch (err) {
        if (status) status.textContent = 'Error: ' + err.message;
        if (btn) btn.textContent = 'Launch Preview';
        if (btn) btn.disabled = false;
      }
    }

    async function stopPreview() {
      const btn = document.getElementById('preview-stop-btn');
      const status = document.getElementById('preview-status');
      if (btn) btn.disabled = true;
      if (btn) btn.textContent = 'Stopping…';
      try {
        const res = await fetch(_previewUrl('/pods/${escapeHtml(pod.id)}/preview'), { method: 'DELETE' });
        if (!res.ok) { const data = await res.json(); throw new Error(data.message || 'Failed to stop preview'); }
        if (status) status.textContent = 'Preview stopped';
        if (btn) btn.textContent = 'Stop Preview';
        if (btn) btn.disabled = false;
        if (btn) btn.classList.add('hidden');
      } catch (err) {
        if (status) status.textContent = 'Error: ' + err.message;
        if (btn) btn.textContent = 'Stop Preview';
        if (btn) btn.disabled = false;
      }
    }
  </script>
</body>
</html>`;
}

function renderHeader(pod: Pod): string {
  const statusColor =
    pod.status === 'complete' || pod.status === 'approved'
      ? 'green'
      : pod.status === 'failed' || pod.status === 'killed'
        ? 'red'
        : pod.status === 'validated'
          ? 'blue'
          : 'yellow';

  return `
    <header class="mb-8">
      <h1 class="text-2xl font-bold mb-4">Validation Report</h1>
      <div class="bg-white rounded-lg shadow p-6 grid grid-cols-2 gap-4 text-sm">
        <div>
          <span class="text-gray-500">Pod</span>
          <p class="font-mono text-xs">${escapeHtml(pod.id)}</p>
        </div>
        <div>
          <span class="text-gray-500">Status</span>
          <p><span class="inline-block px-2 py-0.5 rounded text-xs font-medium bg-${statusColor}-100 text-${statusColor}-800">${escapeHtml(pod.status)}</span></p>
        </div>
        <div class="col-span-2">
          <span class="text-gray-500">Task</span>
          <p class="font-medium">${escapeHtml(pod.task)}</p>
        </div>
        <div>
          <span class="text-gray-500">Profile</span>
          <p>${escapeHtml(pod.profileName)}</p>
        </div>
        <div>
          <span class="text-gray-500">Branch</span>
          <p class="font-mono text-xs">${escapeHtml(pod.branch)}</p>
        </div>
        ${
          pod.prUrl
            ? `
        <div>
          <span class="text-gray-500">Pull Request</span>
          <p><a href="${escapeHtml(pod.prUrl)}" class="text-blue-600 underline" target="_blank">${escapeHtml(pod.prUrl)}</a></p>
        </div>`
            : ''
        }
        <div>
          <span class="text-gray-500">Created</span>
          <p>${escapeHtml(pod.createdAt)}</p>
        </div>
        ${
          pod.completedAt
            ? `
        <div>
          <span class="text-gray-500">Completed</span>
          <p>${escapeHtml(pod.completedAt)}</p>
        </div>`
            : ''
        }
        <div>
          <span class="text-gray-500">Changes</span>
          <p>${pod.filesChanged} files, <span class="text-green-600">+${pod.linesAdded}</span> / <span class="text-red-600">-${pod.linesRemoved}</span></p>
        </div>
      </div>
    </header>`;
}

function renderPreviewSection(pod: Pod): string {
  // Only show preview controls for pods that have a container and are post-validation
  if (!pod.containerId || !pod.previewUrl) return '';
  const postValidationStatuses = ['validated', 'failed', 'approved', 'complete', 'killed'];
  if (!postValidationStatuses.includes(pod.status)) return '';

  return `
    <section class="mb-6">
      <div class="bg-white rounded-lg shadow p-4 flex items-center gap-4">
        <div class="flex-1">
          <h2 class="text-sm font-semibold text-gray-700 mb-1">Preview Environment</h2>
          <p id="preview-status" class="text-sm text-gray-500">Preview stopped — click Launch to start the app</p>
        </div>
        <button
          id="preview-start-btn"
          onclick="startPreview()"
          class="px-4 py-2 bg-green-600 text-white text-sm font-medium rounded hover:bg-green-700 transition-colors">
          Launch Preview
        </button>
        <button
          id="preview-stop-btn"
          onclick="stopPreview()"
          class="hidden px-4 py-2 bg-red-600 text-white text-sm font-medium rounded hover:bg-red-700 transition-colors">
          Stop Preview
        </button>
      </div>
    </section>`;
}

function renderAttemptTimeline(validations: StoredValidation[]): string {
  if (validations.length === 0) return '';

  const tabs = validations.map((v) => {
    const color = v.result.overall === 'pass' ? 'green' : 'red';
    return `<button
      id="tab-${v.attempt}"
      class="tab-btn px-4 py-2 border-b-2 border-transparent text-sm font-medium rounded-t hover:bg-gray-100 transition-colors"
      onclick="showTab(${v.attempt})">
      <span class="inline-block w-2 h-2 rounded-full bg-${color}-500 mr-1.5"></span>
      Attempt ${v.attempt}
    </button>`;
  });

  return `
    <nav class="flex gap-1 border-b border-gray-200 mb-6">
      ${tabs.join('\n')}
    </nav>`;
}

function renderNoValidations(): string {
  return `
    <div class="bg-white rounded-lg shadow p-8 text-center text-gray-500">
      <p class="text-lg">No validation attempts yet.</p>
      <p class="text-sm mt-1">Validation results will appear here once the pod reaches the validation phase.</p>
    </div>`;
}

function renderAttempt(v: StoredValidation, _index: number, _total: number): string {
  const r = v.result;

  return `
    <div id="attempt-${v.attempt}" class="tab-content space-y-4">
      <div class="flex items-center justify-between">
        <h2 class="text-lg font-semibold">Attempt ${v.attempt}</h2>
        <div class="flex items-center gap-3 text-sm text-gray-500">
          <span>${escapeHtml(v.createdAt)}</span>
          <span>${(r.duration / 1000).toFixed(1)}s</span>
          ${renderBadge(r.overall)}
        </div>
      </div>

      ${renderBuildPhase(r.smoke.build)}
      ${r.test ? renderTestPhase(r.test) : ''}
      ${renderHealthPhase(r.smoke.health)}
      ${renderSmokePages(r.smoke.pages)}
      ${r.acValidation ? renderAcValidation(r.acValidation) : ''}
      ${r.taskReview ? renderTaskReview(r.taskReview) : r.reviewSkipReason ? renderPhaseCard('AI Task Review', 'skip', `<p>${escapeHtml(r.reviewSkipReason)}</p>`) : ''}
    </div>`;
}

function renderBadge(status: string): string {
  const color = status === 'pass' ? 'green' : status === 'fail' ? 'red' : 'yellow';
  return `<span class="px-2 py-0.5 rounded text-xs font-medium bg-${color}-100 text-${color}-800">${escapeHtml(status)}</span>`;
}

function renderPhaseCard(title: string, status: string, content: string): string {
  const borderColor =
    status === 'pass'
      ? 'border-green-400'
      : status === 'fail'
        ? 'border-red-400'
        : 'border-yellow-400';
  return `
    <details class="bg-white rounded-lg shadow border-l-4 ${borderColor}" ${status === 'fail' ? 'open' : ''}>
      <summary class="px-4 py-3 cursor-pointer flex items-center justify-between">
        <span class="font-medium">${escapeHtml(title)}</span>
        ${renderBadge(status)}
      </summary>
      <div class="px-4 pb-4">
        ${content}
      </div>
    </details>`;
}

function renderBuildPhase(build: { status: string; output: string; duration: number }): string {
  const content = `
    <p class="text-xs text-gray-500 mb-2">${(build.duration / 1000).toFixed(1)}s</p>
    ${build.output ? `<pre class="bg-gray-900 text-gray-100 p-3 rounded text-xs max-h-64 overflow-y-auto">${escapeHtml(build.output)}</pre>` : '<p class="text-sm text-gray-500">No output.</p>'}`;
  return renderPhaseCard('Build', build.status, content);
}

function renderTestPhase(test: {
  status: string;
  duration: number;
  stdout?: string;
  stderr?: string;
}): string {
  const output = [test.stdout, test.stderr].filter(Boolean).join('\n\n---\n\n');
  const content = `
    <p class="text-xs text-gray-500 mb-2">${(test.duration / 1000).toFixed(1)}s</p>
    ${output ? `<pre class="bg-gray-900 text-gray-100 p-3 rounded text-xs max-h-64 overflow-y-auto">${escapeHtml(output)}</pre>` : '<p class="text-sm text-gray-500">No output.</p>'}`;
  return renderPhaseCard('Tests', test.status, content);
}

function renderHealthPhase(health: {
  status: string;
  url: string;
  responseCode: number | null;
  duration: number;
}): string {
  const content = `
    <div class="text-sm space-y-1">
      <p><span class="text-gray-500">URL:</span> ${escapeHtml(health.url)}</p>
      <p><span class="text-gray-500">Response:</span> ${health.responseCode ?? 'No response'}</p>
      <p><span class="text-gray-500">Duration:</span> ${(health.duration / 1000).toFixed(1)}s</p>
    </div>`;
  return renderPhaseCard('Health Check', health.status, content);
}

function renderSmokePages(
  pages: Array<{
    path: string;
    status: string;
    screenshotBase64?: string;
    consoleErrors: string[];
    assertions: Array<{
      selector: string;
      type: string;
      expected?: string;
      actual?: string;
      passed: boolean;
    }>;
    loadTime: number;
  }>,
): string {
  if (pages.length === 0) return '';

  const allPass = pages.every((p) => p.status === 'pass');
  const content = pages
    .map(
      (page) => `
    <div class="border rounded p-3 space-y-2 ${page.status === 'fail' ? 'border-red-200 bg-red-50' : 'border-gray-200'}">
      <div class="flex items-center justify-between">
        <span class="font-mono text-sm">${escapeHtml(page.path)}</span>
        <div class="flex items-center gap-2">
          <span class="text-xs text-gray-500">${page.loadTime}ms</span>
          ${renderBadge(page.status)}
        </div>
      </div>
      ${page.screenshotBase64 ? `<img src="data:image/png;base64,${page.screenshotBase64}" alt="Screenshot of ${escapeHtml(page.path)}" class="rounded border max-w-full" />` : ''}
      ${
        page.assertions.length > 0
          ? `
        <table class="w-full text-xs">
          <thead><tr class="text-left text-gray-500"><th class="py-1">Selector</th><th>Type</th><th>Expected</th><th>Actual</th><th>Result</th></tr></thead>
          <tbody>
            ${page.assertions
              .map(
                (a) => `
              <tr class="${a.passed ? '' : 'text-red-700 bg-red-50'}">
                <td class="py-1 font-mono">${escapeHtml(a.selector)}</td>
                <td>${escapeHtml(a.type)}</td>
                <td>${a.expected != null ? escapeHtml(a.expected) : '—'}</td>
                <td>${a.actual != null ? escapeHtml(a.actual) : '—'}</td>
                <td>${a.passed ? '✓' : '✗'}</td>
              </tr>`,
              )
              .join('')}
          </tbody>
        </table>`
          : ''
      }
      ${
        page.consoleErrors.length > 0
          ? `
        <div class="text-xs">
          <p class="text-red-600 font-medium">Console errors:</p>
          <pre class="bg-red-900 text-red-100 p-2 rounded mt-1">${escapeHtml(page.consoleErrors.join('\n'))}</pre>
        </div>`
          : ''
      }
    </div>`,
    )
    .join('\n');

  return renderPhaseCard(`Smoke Pages (${pages.length})`, allPass ? 'pass' : 'fail', content);
}

function renderAcValidation(acValidation: {
  status: string;
  results: Array<{
    criterion: string;
    passed: boolean;
    screenshot?: string;
    reasoning: string;
  }>;
  model: string;
}): string {
  if (acValidation.status === 'skip' || acValidation.results.length === 0) return '';

  const passCount = acValidation.results.filter((r) => r.passed).length;
  const content = `
    <p class="text-xs text-gray-500 mb-3">Model: ${escapeHtml(acValidation.model)} — ${passCount}/${acValidation.results.length} passed</p>
    ${acValidation.results
      .map(
        (check) => `
      <div class="border rounded p-3 space-y-2 ${check.passed ? 'border-gray-200' : 'border-red-200 bg-red-50'}">
        <div class="flex items-center justify-between">
          <span class="text-sm font-medium">${escapeHtml(check.criterion)}</span>
          ${renderBadge(check.passed ? 'pass' : 'fail')}
        </div>
        <p class="text-sm text-gray-600">${escapeHtml(check.reasoning)}</p>
        ${check.screenshot ? `<img src="data:image/png;base64,${check.screenshot}" alt="Screenshot for: ${escapeHtml(check.criterion)}" class="rounded border max-w-full" />` : ''}
      </div>`,
      )
      .join('\n')}`;

  return renderPhaseCard(
    `AC Validation (${acValidation.results.length})`,
    acValidation.status,
    content,
  );
}

function renderTaskReview(review: {
  status: string;
  reasoning: string;
  issues: string[];
  model: string;
  diff: string;
}): string {
  const content = `
    <div class="space-y-3">
      <p class="text-xs text-gray-500">Model: ${escapeHtml(review.model)}</p>
      <div>
        <p class="text-sm font-medium mb-1">Reasoning</p>
        <div class="bg-gray-50 p-3 rounded text-sm">${escapeHtml(review.reasoning)}</div>
      </div>
      ${
        review.issues.length > 0
          ? `
        <div>
          <p class="text-sm font-medium mb-1 text-red-700">Issues (${review.issues.length})</p>
          <ul class="list-disc list-inside text-sm space-y-1">
            ${review.issues.map((i) => `<li>${escapeHtml(i)}</li>`).join('')}
          </ul>
        </div>`
          : ''
      }
      ${
        review.diff
          ? `
        <details>
          <summary class="text-sm font-medium cursor-pointer">Diff</summary>
          <pre class="bg-gray-900 text-gray-100 p-3 rounded text-xs mt-2 max-h-96 overflow-y-auto">${escapeHtml(review.diff)}</pre>
        </details>`
          : ''
      }
    </div>`;
  return renderPhaseCard('AI Task Review', review.status, content);
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
