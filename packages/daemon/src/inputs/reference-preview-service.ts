import { AutopodError, type InputBundleRef, inputPathSchema } from '@autopod/shared';
import type { InputBundleStore } from './input-bundle-store.js';
import type { ReferencePreview, ReferenceRenderer } from './reference-renderer.js';

export class ReferencePreviewService {
  private readonly pending = new Map<string, Promise<ReferencePreview>>();
  constructor(
    private readonly store: InputBundleStore,
    private readonly renderer: ReferenceRenderer,
  ) {}
  async available(): Promise<boolean> {
    return this.renderer.available ? this.renderer.available() : true;
  }
  async render(id: string, owner: string, rawPath: string): Promise<ReferencePreview> {
    const entrypoint = inputPathSchema.parse(rawPath);
    const { status: _, ...ref } = this.store.get(id, owner);
    this.store.assert(ref, owner);
    if (ref.files.find((file) => file.path === entrypoint)?.mediaType !== 'text/html')
      throw new AutopodError(
        'Select an HTML file in this admitted bundle',
        'REFERENCE_RENDER_INPUT',
        400,
      );
    const originals = ref.files.map((_file, index) => this.store.read(ref.id, owner, index));
    const cached = this.store.preview(ref, owner, entrypoint);
    if (cached) return cached;
    const key = JSON.stringify([ref.id, entrypoint, this.renderer.image]);
    const existing = this.pending.get(key);
    if (existing) return existing;
    const work = this.renderer
      .render(ref, entrypoint, originals)
      .then((preview) => this.store.savePreview(ref, owner, preview))
      .finally(() => this.pending.delete(key));
    this.pending.set(key, work);
    return work;
  }
  async renderAdmitted(
    ref: InputBundleRef,
    owner: string,
    path: string,
  ): Promise<ReferencePreview> {
    this.store.assert(ref, owner);
    return this.render(ref.id, owner, path);
  }
  async forReview(
    ref: InputBundleRef,
    owner: string,
    signal?: AbortSignal,
  ): Promise<ReferencePreview[]> {
    signal?.throwIfAborted();
    this.store.assert(ref, owner);
    const html = ref.files.filter((file) => file.mediaType === 'text/html');
    if (html.length > 4)
      throw new AutopodError(
        'Reference review renders at most 4 HTML files per bundle',
        'REFERENCE_RENDER_LIMIT',
        400,
      );
    const previews: ReferencePreview[] = [];
    // Sequential per bundle; global renderer concurrency is separately bounded.
    for (const file of html) {
      signal?.throwIfAborted();
      previews.push(await this.render(ref.id, owner, file.path));
    }
    signal?.throwIfAborted();
    return previews;
  }
}
