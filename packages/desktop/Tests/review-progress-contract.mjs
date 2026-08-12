import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const files = {
  response: 'packages/desktop/Sources/AutopodClient/Types/PodResponse.swift',
  event: 'packages/desktop/Sources/AutopodClient/Types/EventTypes.swift',
  mapper: 'packages/desktop/Sources/AutopodDesktop/Mapping/PodMapper.swift',
  stream: 'packages/desktop/Sources/AutopodDesktop/Stores/EventStream.swift',
  store: 'packages/desktop/Sources/AutopodDesktop/Stores/PodStore.swift',
  model: 'packages/desktop/Sources/AutopodUI/Models/Pod.swift',
  card: 'packages/desktop/Sources/AutopodUI/Views/Cards/PodCardFinal.swift',
  validation: 'packages/desktop/Sources/AutopodUI/Views/Detail/ValidationTab.swift',
  liveView: 'packages/desktop/Sources/AutopodUI/Views/Detail/LiveReviewProgressView.swift',
  activity: 'packages/desktop/Sources/AutopodUI/Views/Shared/ActivityFeedList.swift',
};

const source = Object.fromEntries(
  Object.entries(files).map(([name, path]) => [name, readFileSync(path, 'utf8')]),
);

assert.match(source.response, /reviewProgress: ReviewProgressResponse\?/);
assert.match(source.event, /case "pod\.review_progress"/);
assert.match(source.mapper, /mapReviewProgress/);
assert.match(source.stream, /case \.reviewProgress/);
assert.match(source.store, /current\.updatedAt > progress\.updatedAt/);
assert.match(source.model, /status == \.completed \|\| \$0\.status == \.unavailable/);
assert.match(source.card, /settled/);
assert.match(source.validation, /LiveReviewProgressView/);
assert.match(source.liveView, /Unavailable/);
assert.match(source.liveView, /timeLabel/);
assert.match(source.model, /guardrail/);
assert.match(source.activity, /groupReviewCouncilActivity/);
assert.doesNotMatch(source.liveView, /percent|ETA/i);

console.log('Review progress desktop contract OK');
