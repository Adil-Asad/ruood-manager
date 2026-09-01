/**
 * The typed client for the Manager's own server.
 *
 * Every call is same-origin — in dev because Vite proxies `/api`, in the built
 * client because the server serves both. So there is no base URL to configure
 * and no credential to carry: the only thing on the other end is a process on
 * this machine that was started against one repository.
 *
 * Errors arrive as `{ error, issues? }` and are thrown as `ApiFailure`, which
 * keeps the issues attached so a form can hang them off the right field
 * instead of printing a paragraph.
 */

import type {
  BuildSummary,
  Channel,
  DeleteRecordResponse,
  GitLogEntry,
  IdCheckResponse,
  ImageAttachResponse,
  ManagerState,
  NewRecordRequest,
  PublishRequest,
  PublishResponse,
  PushOutcome,
  RecordDetail,
  Transition,
} from '../shared/api';
import type { ValidationIssue } from '@ruood/announcement-schema';

export class ApiFailure extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly issues: ValidationIssue[] = [],
  ) {
    super(message);
    this.name = 'ApiFailure';
  }
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const response = await fetch(url, {
    method,
    // Always JSON, including on a DELETE with nothing to say. The server
    // refuses any content type an HTML form could produce, which is what stops
    // a page on another site from reaching these routes at all.
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });

  return unwrap<T>(response);
}

async function unwrap<T>(response: Response): Promise<T> {
  if (response.status === 204) return undefined as T;

  const text = await response.text();
  const payload = text ? (JSON.parse(text) as unknown) : null;

  if (!response.ok) {
    const failure = payload as { error?: string; issues?: ValidationIssue[] } | null;
    throw new ApiFailure(
      response.status,
      failure?.error ?? `The Manager answered ${response.status}.`,
      failure?.issues ?? [],
    );
  }

  return payload as T;
}

export const api = {
  state: (): Promise<ManagerState> =>
    fetch('/api/state').then((response) => unwrap<ManagerState>(response)),

  record: (id: string): Promise<RecordDetail> =>
    fetch(`/api/records/${encodeURIComponent(id)}`).then((r) => unwrap<RecordDetail>(r)),

  checkId: (id: string): Promise<IdCheckResponse> =>
    fetch(`/api/id-check?id=${encodeURIComponent(id)}`).then((r) => unwrap<IdCheckResponse>(r)),

  create: (input: NewRecordRequest): Promise<RecordDetail> =>
    request('POST', '/api/records', input),

  edit: (id: string, edits: Record<string, unknown>): Promise<RecordDetail> =>
    request('PATCH', `/api/records/${encodeURIComponent(id)}`, { edits }),

  transition: (id: string, transition: Transition): Promise<RecordDetail> =>
    request('POST', `/api/records/${encodeURIComponent(id)}/transition`, { transition }),

  /** Re-shows the announcement to every device that has already seen it. */
  bump: (id: string): Promise<RecordDetail> =>
    request('POST', `/api/records/${encodeURIComponent(id)}/bump`),

  remove: (id: string): Promise<DeleteRecordResponse> =>
    request('DELETE', `/api/records/${encodeURIComponent(id)}`, { acknowledgeIdRetired: true }),

  attachImage: async (
    id: string,
    file: File,
    alt: string | null,
  ): Promise<ImageAttachResponse> => {
    const query = new URLSearchParams({ filename: file.name });
    if (alt) query.set('alt', alt);

    const response = await fetch(
      `/api/records/${encodeURIComponent(id)}/image?${query.toString()}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: file,
      },
    );

    return unwrap<ImageAttachResponse>(response);
  },

  detachImage: (id: string): Promise<RecordDetail> =>
    request('DELETE', `/api/records/${encodeURIComponent(id)}/image`),

  validate: (channel: Channel = 'production'): Promise<BuildSummary> =>
    request('POST', '/api/validate', { channel }),

  build: (channel: Channel = 'production'): Promise<BuildSummary> =>
    request('POST', '/api/build', { channel }),

  publish: (input: PublishRequest): Promise<PublishResponse> =>
    request('POST', '/api/publish', input),

  log: (limit = 20): Promise<GitLogEntry[]> =>
    fetch(`/api/git/log?limit=${limit}`).then((r) => unwrap<GitLogEntry[]>(r)),

  push: (): Promise<PushOutcome> => request('POST', '/api/git/push'),

  revert: (commit: string): Promise<{ reverted: string; commit: string }> =>
    request('POST', '/api/git/revert', { commit }),
};
