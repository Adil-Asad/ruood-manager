/**
 * The tiny slice of `fetch` this package uses, declared rather than imported.
 *
 * The package compiles with `lib: ["ES2020"]` and no `DOM`, deliberately: it
 * has to typecheck the same way for the browser client, for Hermes and for a
 * node test, and pulling in `DOM` would let a `document` reference compile here
 * and crash on a phone.
 *
 * So the transport is a PORT. The browser passes its `fetch`, React Native
 * passes its `fetch`, and a test passes a function. Declaring only `status`,
 * `ok` and `text()` is what makes all three assignable — a real `Response` has
 * far more, and extra members are fine.
 *
 * The members are written in method shorthand on purpose. TypeScript checks
 * method parameters bivariantly, which is what lets a platform `fetch` — whose
 * `init` is a much richer type — satisfy this narrower one without a cast at
 * every call site.
 */

export interface HttpRequestInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: unknown;
}

export interface HttpResponse {
  status: number;
  ok: boolean;
  text(): Promise<string>;
}

export interface Http {
  fetch(url: string, init?: HttpRequestInit): Promise<HttpResponse>;
}

/**
 * Timers and `AbortController`, reached through `globalThis`.
 *
 * They exist in a browser, in Hermes and in node, but they are typed by `DOM`
 * and by `@types/node` — and this package compiles with neither, deliberately,
 * so that a `document` reference cannot slip in behind them. Declaring them as
 * ambient globals here would leak into whatever imports this package and could
 * then disagree with the real declarations; a narrow view of `globalThis` says
 * exactly what is used and pollutes nothing.
 *
 * `AbortController` is optional in the type because a runtime without one
 * should cost the request timeout, not the request.
 */
export const runtime = globalThis as unknown as {
  setTimeout(handler: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  AbortController?: new () => { readonly signal: unknown; abort(): void };
};

/**
 * A failure the caller can act on rather than only print.
 *
 * `issues` is kept attached so a form can hang a validator message off the
 * right field instead of showing a paragraph above the whole screen. `status`
 * is kept because 401 means "re-pair" and 409 means "look at the repository",
 * and those are different screens.
 */
export class ApiFailure extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly issues: readonly { path: string; message: string }[] = [],
  ) {
    super(message);
    this.name = 'ApiFailure';
  }

  /** The token is wrong, missing, or has been rotated on the server. */
  get isAuthFailure(): boolean {
    return this.status === 401 || this.status === 403;
  }
}

/**
 * A transport failure — no route to the server at all.
 *
 * Distinguished from `ApiFailure` because they need opposite messages: an
 * `ApiFailure` means the Manager answered and refused, and this means the
 * Manager was never reached, which on a phone is nearly always the network or a
 * server that is not running.
 */
export class ConnectionFailure extends Error {
  constructor(
    readonly baseUrl: string,
    /**
     * The error `fetch` actually threw.
     *
     * Named `underlying` rather than `cause` deliberately. `Error.cause` exists
     * from ES2022, and this package compiles against ES2020 while the app that
     * consumes it compiles against a newer lib — so a field called `cause`
     * would be an accidental override in one build and not the other, and only
     * one of the two would say so.
     */
    readonly underlying: unknown,
  ) {
    super(
      `Could not reach the Manager at ${baseUrl}. It may not be running, or this device may ` +
        'not be on the same network.',
    );
    this.name = 'ConnectionFailure';
  }
}
